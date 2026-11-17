// SQLite storage. Production DBs are encrypted (SQLCipher via better-sqlite3-multiple-ciphers); tests use node:sqlite.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | bigint | null | Uint8Array;
export interface SqlStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}
export interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface CoreDb {
  sql: SqlDb;
  /** True only for in-memory / temp-dir test databases. */
  readonly unencryptedForDev: boolean;
  /** Run fn in a transaction (nested calls become savepoints). */
  tx<T>(fn: () => T): T;
  /** Open a transaction that the caller commits later (cannot be nested). */
  begin(): { commit(): void; rollback(): void };
  /** Run fn after the outermost transaction commits (immediately if none is open). */
  afterCommit(fn: () => void): void;
  onAfterCommitError: ((e: unknown) => void) | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, kind TEXT NOT NULL, priority INTEGER NOT NULL,
  not_before TEXT, uses_browser INTEGER NOT NULL, created_at TEXT NOT NULL, row TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state, priority, created_at);
CREATE TABLE IF NOT EXISTS task_seq (day TEXT NOT NULL, prefix TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, prefix));
CREATE TABLE IF NOT EXISTS steps (
  task_id TEXT NOT NULL, call_id TEXT NOT NULL, state TEXT NOT NULL, call_seq INTEGER NOT NULL, row TEXT NOT NULL,
  PRIMARY KEY (task_id, call_id));
CREATE TABLE IF NOT EXISTS budget_caps (scope TEXT NOT NULL, id TEXT NOT NULL, cap_mkrw INTEGER, PRIMARY KEY (scope, id));
CREATE TABLE IF NOT EXISTS budget_res (
  id TEXT PRIMARY KEY, keys TEXT NOT NULL, estimate_mkrw INTEGER NOT NULL, actual_mkrw INTEGER, state TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budget_res_keys (res_id TEXT NOT NULL, scope TEXT NOT NULL, key_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS budget_res_keys_k ON budget_res_keys(scope, key_id);
CREATE TABLE IF NOT EXISTS approvals (token_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, issued_by TEXT NOT NULL, token TEXT NOT NULL, uses INTEGER NOT NULL, at TEXT NOT NULL, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS approvals_task ON approvals(task_id);
`;

export const SCHEMA_VERSION = 1;
const VERSION_KEY = "schema_version";

/** Migration step v -> v+1. Add entries here when SCHEMA changes; a fresh DB is created at SCHEMA_VERSION directly. */
export type SchemaStep = (sql: SqlDb) => void;
export const SCHEMA_MIGRATIONS: Readonly<Record<number, SchemaStep>> = {};

export class SchemaVersionError extends Error {
  readonly found: number | null;
  readonly kind: "newer" | "older" | "unversioned" | "not_fresh" | "bad_step";
  constructor(kind: SchemaVersionError["kind"], found: number | null) {
    super(`schema version mismatch: ${kind} (found ${found ?? "none"}, expected ${SCHEMA_VERSION})`);
    this.kind = kind;
    this.found = found;
  }
}
export class DbCheckpointError extends Error {}

function hasTables(sql: SqlDb): boolean {
  return ((sql.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n) > 0;
}

export function readSchemaVersion(sql: SqlDb): number | null {
  const meta = sql.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() as { n: number };
  if (meta.n === 0) return null;
  const r = sql.prepare("SELECT v FROM meta WHERE k = ?").get(VERSION_KEY) as { v: string } | undefined;
  if (!r || !/^[1-9][0-9]{0,5}$/u.test(r.v)) return null;
  return Number(r.v);
}

export type SchemaState = { kind: "fresh" } | { kind: "unversioned" } | { kind: "versioned"; version: number };
export function inspectSchema(sql: SqlDb): SchemaState {
  if (!hasTables(sql)) return { kind: "fresh" };
  const v = readSchemaVersion(sql);
  return v === null ? { kind: "unversioned" } : { kind: "versioned", version: v };
}

function writeVersion(sql: SqlDb, v: number): void {
  sql.prepare("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(VERSION_KEY, String(v));
}

function initSchema(sql: SqlDb): void {
  sql.exec("BEGIN IMMEDIATE");
  try {
    sql.exec(SCHEMA);
    writeVersion(sql, SCHEMA_VERSION);
    sql.exec("COMMIT");
  } catch (e) {
    sql.exec("ROLLBACK");
    throw e;
  }
}

function connectionPragmas(sql: SqlDb): void {
  sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
}

function wrapReady(sql: SqlDb, unencryptedForDev: boolean): CoreDb {
  let depth = 0;
  let open = false;

  let queue: Array<() => void> = [];
  const self: CoreDb = {
    sql,
    unencryptedForDev,
    onAfterCommitError: null,
    tx<T>(fn: () => T): T {
      const name = `sp${depth}`;
      const outer = depth === 0 && !open;
      const mark = queue.length;
      sql.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
      depth++;
      let r: T;
      try {
        r = fn();
      } catch (e) {
        depth--;
        sql.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
        queue.length = outer ? 0 : mark;
        throw e;
      }
      depth--;

      try {
        sql.exec(outer ? "COMMIT" : `RELEASE ${name}`);
      } catch (e) {
        if (outer) {
          try { sql.exec("ROLLBACK"); } catch { }
          queue.length = 0;
        } else {
          try { sql.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); } catch { }
          queue.length = mark;
        }
        throw e;
      }
      if (outer) flush();
      return r;
    },
    begin() {
      if (open || depth > 0) throw new Error("begin() cannot be nested inside another transaction");
      sql.exec("BEGIN IMMEDIATE");
      open = true;
      let done = false;
      return {
        commit() {
          if (done) return;
          done = true; open = false;
          try { sql.exec("COMMIT"); } catch (e) {
            try { sql.exec("ROLLBACK"); } catch { }
            queue = [];
            throw e;
          }
          flush();
        },
        rollback() { if (done) return; done = true; open = false; sql.exec("ROLLBACK"); queue = []; },
      };
    },
    afterCommit(fn: () => void): void {
      if (depth === 0 && !open) { call(fn); return; }
      queue.push(fn);
    },
  };

  const call = (f: () => void) => {
    try { f(); } catch (e) {
      try { self.onAfterCommitError?.(e); } catch { }
    }
  };
  const flush = () => {
    const q = queue; queue = [];
    for (const f of q) call(f);
  };
  return self;
}

export function wrapDb(sql: SqlDb, unencryptedForDev: boolean): CoreDb {
  const st = inspectSchema(sql);
  if (st.kind === "versioned" && st.version > SCHEMA_VERSION) throw new SchemaVersionError("newer", st.version);
  connectionPragmas(sql);
  if (st.kind === "fresh") initSchema(sql);
  else if (st.kind === "versioned" && st.version < SCHEMA_VERSION) migrateSchema(sql, st.version);
  else if (st.kind === "unversioned") throw new SchemaVersionError("unversioned", null);
  return wrapReady(sql, unencryptedForDev);
}

export function attachCoreDb(sql: SqlDb, expect: "fresh" | "same", unencryptedForDev = false): CoreDb {
  const st = inspectSchema(sql);
  if (expect === "fresh") {
    if (st.kind !== "fresh") throw new SchemaVersionError("not_fresh", st.kind === "versioned" ? st.version : null);
    connectionPragmas(sql);
    initSchema(sql);
  } else {
    if (st.kind !== "versioned") throw new SchemaVersionError(st.kind === "fresh" ? "not_fresh" : "unversioned", null);
    if (st.version !== SCHEMA_VERSION) throw new SchemaVersionError(st.version > SCHEMA_VERSION ? "newer" : "older", st.version);
    connectionPragmas(sql);
  }
  return wrapReady(sql, unencryptedForDev);
}

export function migrateSchema(sql: SqlDb, from: number, opts?: { to?: number; steps?: Readonly<Record<number, SchemaStep>> }): void {
  const to = opts?.to ?? SCHEMA_VERSION;
  const steps = opts?.steps ?? SCHEMA_MIGRATIONS;
  const found = readSchemaVersion(sql);
  if (found !== from) throw new SchemaVersionError(found === null ? "unversioned" : found > from ? "newer" : "older", found);
  if (!(from < to)) throw new SchemaVersionError("newer", found);
  for (let v = from; v < to; v++) if (typeof steps[v] !== "function") throw new SchemaVersionError("bad_step", v);
  sql.exec("BEGIN IMMEDIATE");
  try {
    for (let v = from; v < to; v++) steps[v]!(sql);
    writeVersion(sql, to);
    sql.exec("COMMIT");
  } catch (e) {
    sql.exec("ROLLBACK");
    throw e;
  }
}

export function checkpointAndClose(sql: SqlDb): void {
  const r = sql.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
  if (r && Number(r.busy) !== 0) throw new DbCheckpointError("WAL checkpoint incomplete (another connection is writing)");
  sql.close();
}

interface CipherDatabase extends SqlDb {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  key(key: Buffer): number;
}
type CipherCtor = new (path: string, options?: { fileMustExist?: boolean }) => CipherDatabase;

export class DbKeyError extends Error {}

export function openCoreDbRaw(path: string, key: Uint8Array): SqlDb {
  if (key.length !== 32) throw new Error("DB key must be 32 bytes");
  const Database = createRequire(import.meta.url)("better-sqlite3-multiple-ciphers") as CipherCtor;
  const db = new Database(path);
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma("legacy = 4");
    db.key(Buffer.from(key));
    db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
  } catch (e) {
    db.close();
    throw new DbKeyError(`cannot open DB (wrong key or not an encrypted file): ${(e as { code?: string }).code ?? (e as Error).message}`);
  }
  return db;
}

export function openCoreDb(path: string, key: Uint8Array): CoreDb {
  const sql = openCoreDbRaw(path, key);
  try { return wrapDb(sql, false); } catch (e) { sql.close(); throw e; }
}

export function isUnderTmp(p: string): boolean {
  const real = (x: string) => { try { return realpathSync(x); } catch { return resolve(x); } };
  const t = real(tmpdir());
  let d = resolve(p);
  for (;;) {
    try { d = realpathSync(d); break; } catch { const up = dirname(d); if (up === d) break; d = up; }
  }
  return d === t || d.startsWith(t + sep);
}

export function openUnencryptedDevDb(path: string): CoreDb {
  if (!isUnderTmp(path)) throw new Error(`unencrypted DB is only allowed under the OS temp dir: ${path}`);
  return wrapDb(new DatabaseSync(path) as unknown as SqlDb, true);
}

export function openMemoryDb(): CoreDb {
  return wrapDb(new DatabaseSync(":memory:") as unknown as SqlDb, true);
}
