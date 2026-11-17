// Durable task queue: state machine, leases, priority/not-before scheduling. Every transition is written to the event log.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CoreDb } from "../db.ts";
import type { LogWriter } from "../log/writer.ts";
import { seoulDateCompact, seoulIso, parseIso, type Clock } from "../util/time.ts";
import type { CaseId, ConcurrencyLimits, IsoTime, NewTask, TaskId, TaskKind, TaskRow, TaskState, Why } from "../types.ts";

const END: ReadonlySet<TaskState> = new Set(["done", "failed", "stopped", "canceled"]);

const ALLOWED: Record<TaskState, readonly TaskState[]> = {
  planned: ["running", "waiting", "canceled"],
  running: ["waiting", "done", "failed", "stopped", "canceled", "planned"],
  waiting: ["planned", "canceled", "stopped", "failed"],
  done: [], failed: [], stopped: [], canceled: [],
};

export class TransitionError extends Error {}

export function readRow(json: string): TaskRow {
  return JSON.parse(json) as TaskRow;
}

export class TaskStore {
  private readonly db: CoreDb;
  private readonly log: LogWriter;
  private readonly clock: Clock;

  onChange: ((taskId: TaskId) => void) | null = null;

  /** While inside hold(), change notifications are queued and fired after the outer transaction commits. */
  private held: TaskId[] | null = null;
  private changed(id: TaskId): void {
    if (this.held) { this.held.push(id); return; }
    this.onChange?.(id);
  }

  hold<T>(fn: () => T): T {
    if (this.held) return fn();
    this.held = [];
    let ids: TaskId[];
    let r: T;
    try { r = fn(); ids = this.held; } finally { this.held = null; }

    this.db.afterCommit(() => { for (const id of ids) { try { this.onChange?.(id); } catch (e) { try { this.db.onAfterCommitError?.(e); } catch { } } } });
    return r;
  }

  constructor(db: CoreDb, log: LogWriter, clock: Clock) {
    this.db = db;
    this.log = log;
    this.clock = clock;
  }

  private now(): IsoTime { return seoulIso(this.clock()); }

  static readonly ID_RE = /^(?:t|obs)-\d{8}-\d+$/u;
  newTaskId(kind: TaskKind): TaskId {
    const day = seoulDateCompact(this.clock());
    const prefix = kind === "observe" ? "obs" : "t";
    return this.db.tx(() => {
      const row = this.db.sql.prepare("SELECT n FROM task_seq WHERE day = ? AND prefix = ?").get(day, prefix) as { n: number } | undefined;
      let n = (row?.n ?? 0) + 1;
      // Skip ids whose log folder already exists (e.g. after a DB restore).
      while (existsSync(join(this.log.taskDir(`${prefix}-${day}-${n}`), "plan.json"))) n++;
      this.db.sql.prepare("INSERT INTO task_seq(day, prefix, n) VALUES (?, ?, ?) ON CONFLICT(day, prefix) DO UPDATE SET n = excluded.n").run(day, prefix, n);
      return `${prefix}-${day}-${n}`;
    });
  }

  create(id: TaskId, input: NewTask): TaskRow {
    const at = this.now();
    const row: TaskRow = {
      id,
      attemptId: input.attemptId ?? id,
      ...(input.prevTaskId !== undefined ? { prevTaskId: input.prevTaskId } : {}),
      title: input.title,
      planId: input.planId,
      planSha256: input.planSha256,
      kind: input.kind,
      origin: input.origin,
      usesBrowser: input.usesBrowser,
      state: "planned",
      why: null,
      waitingCases: [],
      caseNotBefore: {},
      model: input.model,
      lastSeq: this.log.head(id).seq,
      priority: input.priority ?? 100,
      ...(input.notBefore !== undefined ? { notBefore: input.notBefore } : {}),
      ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.parentCardId !== undefined ? { parentCardId: input.parentCardId } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.db.tx(() => this.write(row, true));
    this.changed(id);
    return row;
  }

  get(id: TaskId): TaskRow | null {
    const r = this.db.sql.prepare("SELECT row FROM tasks WHERE id = ?").get(id) as { row: string } | undefined;
    return r ? readRow(r.row) : null;
  }

  mustGet(id: TaskId): TaskRow {
    const t = this.get(id);
    if (!t) throw new Error(`task not found: ${id}`);
    return t;
  }

  list(filter?: { state?: TaskState[]; kind?: TaskKind[] }): TaskRow[] {
    const rows = this.db.sql.prepare("SELECT row FROM tasks ORDER BY created_at, id").all() as Array<{ row: string }>;
    return rows.map((r) => readRow(r.row))
      .filter((t) => !filter?.state || filter.state.includes(t.state))
      .filter((t) => !filter?.kind || filter.kind.includes(t.kind));
  }

  private write(row: TaskRow, insert: boolean): void {
    const sql = insert
      ? "INSERT INTO tasks(id, state, kind, priority, not_before, uses_browser, created_at, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      : "UPDATE tasks SET state = ?, kind = ?, priority = ?, not_before = ?, uses_browser = ?, created_at = ?, row = ? WHERE id = ?";
    const vals = [row.state, row.kind, row.priority, row.notBefore ?? null, row.usesBrowser ? 1 : 0, row.createdAt, JSON.stringify(row)] as const;
    if (insert) this.db.sql.prepare(sql).run(row.id, ...vals);
    else this.db.sql.prepare(sql).run(...vals, row.id);
  }

  patch(id: TaskId, leaseToken: string | null, f: (t: TaskRow) => void): boolean {
    let ok = false;
    this.db.tx(() => {
      const t = this.get(id);
      if (!t) return;
      if (leaseToken !== null && t.leaseToken !== leaseToken) return;
      f(t);
      t.updatedAt = this.now();
      this.write(t, false);
      ok = true;
    });
    if (ok) this.changed(id);
    return ok;
  }

  claimNext(now: Date, leaseMs: number, limits: ConcurrencyLimits, skip: ReadonlySet<TaskId> = new Set()): TaskRow | null {
    let claimed: TaskRow | null = null;
    this.db.tx(() => {
      const running = this.list({ state: ["running"] }).filter((t) => t.kind !== "observe");
      if (running.length >= limits.maxRunning) return;
      const browserBusy = running.some((t) => t.usesBrowser);
      const cand = this.list({ state: ["planned"] })
        .filter((t) => t.kind !== "observe")
        .filter((t) => !skip.has(t.id))
        .filter((t) => !t.notBefore || parseIso(t.notBefore).getTime() <= now.getTime())
        .filter((t) => !t.usesBrowser || !browserBusy)
        .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
      if (!cand) return;
      const from = cand.state;
      cand.state = "running";
      cand.leaseToken = randomUUID();
      cand.leaseUntil = seoulIso(new Date(now.getTime() + leaseMs));
      cand.updatedAt = seoulIso(now);
      this.write(cand, false);
      this.recordTransition(cand.id, from, "running", "claim");
      claimed = cand;
    });
    if (claimed) this.changed((claimed as TaskRow).id);
    return claimed;
  }

  heartbeat(id: TaskId, leaseToken: string, leaseMs: number): boolean {
    return this.patch(id, leaseToken, (t) => {
      if (t.state !== "running") throw new TransitionError("task is not running");
      t.leaseUntil = seoulIso(new Date(this.clock().getTime() + leaseMs));
    });
  }

  transition(id: TaskId, leaseToken: string | null, to: TaskState, why: Why | null): boolean {
    let from: TaskState | null = null;
    let ok = false;
    this.db.tx(() => {
      const t = this.get(id);
      if (!t) return;
      if (leaseToken !== null && t.leaseToken !== leaseToken) return;
      if (!ALLOWED[t.state].includes(to)) throw new TransitionError(`transition ${t.state} -> ${to} not allowed (${id})`);
      from = t.state;
      t.state = to;
      t.why = why;
      if (to !== "running") { delete t.leaseToken; delete t.leaseUntil; }
      t.updatedAt = this.now();
      this.write(t, false);
      this.recordTransition(id, from, to, why?.kind ?? "none");
      ok = true;
    });
    if (ok) this.changed(id);
    return ok;
  }

  private recordTransition(id: TaskId, from: TaskState, to: TaskState, whyKind: string): void {
    if (this.get(id)?.kind === "observe") return;
    this.log.append("app", { type: "app_event", actor: "app", app_kind: "ops.task_state", subject: id, data: { from, to, why_kind: whyKind } });
  }

  resume(id: TaskId, by: "user" | "scheduler"): boolean {
    const t = this.get(id);
    if (!t || t.state !== "waiting") return false;
    return this.transition(id, null, "planned", null) && (by === "user" || by === "scheduler");
  }

  addWaitingCase(id: TaskId, leaseToken: string | null, caseId: CaseId, notBefore?: IsoTime): boolean {
    return this.patch(id, leaseToken, (t) => {
      if (!t.waitingCases.includes(caseId)) t.waitingCases.push(caseId);
      if (notBefore !== undefined) t.caseNotBefore[caseId] = notBefore;
    });
  }

  removeWaitingCase(id: TaskId, caseId: CaseId): boolean {
    return this.patch(id, null, (t) => {
      t.waitingCases = t.waitingCases.filter((c) => c !== caseId);
      delete t.caseNotBefore[caseId];
    });
  }

  releaseDueCases(now: Date): Array<{ taskId: TaskId; caseId: CaseId }> {
    const out: Array<{ taskId: TaskId; caseId: CaseId }> = [];
    for (const t of this.list({ state: ["running", "waiting", "planned"] })) {
      for (const [c, nb] of Object.entries(t.caseNotBefore)) {
        if (parseIso(nb).getTime() <= now.getTime()) out.push({ taskId: t.id, caseId: c });
      }
    }
    return out;
  }

  expiredRunning(now: Date): TaskRow[] {
    return this.list({ state: ["running"] }).filter((t) => t.kind !== "observe" && (!t.leaseUntil || parseIso(t.leaseUntil).getTime() <= now.getTime()));
  }

  staleRunning(): TaskRow[] {
    return this.list({ state: ["running"] }).filter((t) => t.kind !== "observe");
  }

  isEnd(state: TaskState): boolean { return END.has(state); }
}
