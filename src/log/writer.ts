// Append-only, hash-chained JSONL event log (one file per task plus an app log).
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventHash, normalizeForStore, ZERO_HASH } from "../util/jcs.ts";
import { seoulIso, type Clock } from "../util/time.ts";
import type { EventBody, LoggedEvent, Seq, TaskId } from "../types.ts";

export const APP = "app";
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface Head { seq: Seq; hash: string }
export interface OpenReport { taskId: string; tornBytes: number }

export class LogWriter {
  readonly root: string;
  private readonly clock: Clock;
  private readonly heads = new Map<string, Head>();
  private readonly cache = new Map<string, LoggedEvent[]>();

  beforeAppend: ((taskId: string, body: EventBody) => void) | null = null;
  readonly torn: OpenReport[] = [];

  constructor(root: string, clock: Clock) {
    this.root = root;
    this.clock = clock;
  }

  logPath(taskId: TaskId | "app"): string {
    return taskId === APP ? join(this.root, "app.log.jsonl") : join(this.root, "tasks", taskId, "log.jsonl");
  }
  taskDir(taskId: TaskId): string {
    return join(this.root, "tasks", taskId);
  }

  events(taskId: TaskId | "app"): LoggedEvent[] {
    const hit = this.cache.get(taskId);
    if (hit) return hit;
    const p = this.logPath(taskId);
    const evs: LoggedEvent[] = [];
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8");
      const lines = text.split("\n");
      let goodBytes = 0;
      let torn = "";
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const last = i === lines.length - 1;
        if (last) { torn = line; break; }
        try {
          evs.push(JSON.parse(line) as LoggedEvent);
          goodBytes += Buffer.byteLength(line, "utf8") + 1;
        } catch {
          if (lines.slice(i + 1).some((l) => l.trim() !== "")) throw new Error(`${p}: line ${i + 1} is corrupt and is not the last line (not a torn write)`);
          torn = lines.slice(i).join("\n");
          break;
        }
      }
      if (torn !== "") {
        appendFileSync(`${p}.torn`, torn + "\n");
        const keep = Buffer.from(text, "utf8").subarray(0, goodBytes);
        writeFileSync(p, keep);
        this.torn.push({ taskId, tornBytes: Buffer.byteLength(torn, "utf8") });
      }
    }
    this.cache.set(taskId, evs);
    const lastEv = evs[evs.length - 1];
    this.heads.set(taskId, lastEv ? { seq: lastEv.seq, hash: lastEv.hash } : { seq: 0, hash: ZERO_HASH });
    return evs;
  }

  head(taskId: TaskId | "app"): Head {
    if (!this.heads.has(taskId)) this.events(taskId);
    return this.heads.get(taskId)!;
  }

  append(taskId: TaskId | "app", body: EventBody): { seq: Seq; hash: string } {
    if (taskId !== APP && !ID.test(taskId)) throw new Error(`bad task_id: ${taskId}`);
    if (!body.type) throw new Error("missing type");
    const h = this.head(taskId);
    const { type, actor, ts, ...fields } = body;
    const ev = normalizeForStore({
      schema: "agent-guardrails.log/v0",
      task_id: taskId,
      seq: h.seq + 1,
      ts: ts ?? seoulIso(this.clock()),
      actor: actor ?? "tool_layer",
      type,
      ...fields,
      prev_hash: h.hash,
    }) as Record<string, unknown>;
    const hash = eventHash(ev);
    const full = { ...ev, hash } as LoggedEvent;
    this.beforeAppend?.(taskId, body);
    const p = this.logPath(taskId);
    mkdirSync(dirname(p), { recursive: true });
    const fd = openSync(p, "a");
    try {
      writeSync(fd, JSON.stringify(full) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.heads.set(taskId, { seq: full.seq, hash });
    this.cache.get(taskId)!.push(full);
    return { seq: full.seq, hash };
  }

  writeResult(taskId: TaskId, seq: Seq, content: string): `results/${number}.txt` {
    const rel = `results/${seq}.txt` as const;
    const p = join(this.taskDir(taskId), rel);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, content.normalize("NFC"));
    renameSync(tmp, p);
    return rel;
  }

  readResult(taskId: TaskId, rel: string): string {
    return readFileSync(join(this.taskDir(taskId), rel), "utf8");
  }

  writePlan(taskId: TaskId, bytes: Uint8Array): void {
    const p = join(this.taskDir(taskId), "plan.json");
    if (existsSync(p)) throw new Error(`plan.json already exists: ${taskId}`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
  }

  readPlan(taskId: TaskId): Uint8Array {
    return this.planSource ? this.planSource(taskId) : this.readPlanFile(taskId);
  }

  readPlanFile(taskId: TaskId): Uint8Array {
    return readFileSync(join(this.taskDir(taskId), "plan.json"));
  }
  private planSource: ((taskId: TaskId) => Uint8Array) | null = null;
  setPlanSource(fn: ((taskId: TaskId) => Uint8Array) | null): void { this.planSource = fn; }

  forget(taskId?: TaskId | "app"): void {
    if (taskId === undefined) { this.cache.clear(); this.heads.clear(); return; }
    this.cache.delete(taskId);
    this.heads.delete(taskId);
  }
}
