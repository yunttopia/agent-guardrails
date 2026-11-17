// Step journal: one row per tool call (started -> committed | failed | unknown). Rebuildable from the event log.
import { createHash } from "node:crypto";
import type { CoreDb } from "../db.ts";
import type { LogWriter } from "../log/writer.ts";
import type { CallId, IsoTime, LoggedEvent, Seq, StepRecord, StepState, TaskId, ToolResultStatus } from "../types.ts";

export type StepStart = Omit<StepRecord, "state" | "attempts" | "startedAt" | "resultSeq" | "resultPath" | "reconcileSeq">;

export function defaultIdempotencyKey(taskId: TaskId, callId: CallId, argsHash: string): string {
  return createHash("sha256").update(`${taskId}:${callId}:${argsHash}`).digest("hex");
}

export class StepJournal {
  private readonly db: CoreDb;

  constructor(db: CoreDb) {
    this.db = db;
  }

  private put(r: StepRecord): void {
    this.db.sql.prepare("INSERT INTO steps(task_id, call_id, state, call_seq, row) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, call_id) DO UPDATE SET state = excluded.state, call_seq = excluded.call_seq, row = excluded.row")
      .run(r.taskId, r.callId, r.state, r.callSeq, JSON.stringify(r));
  }

  get(taskId: TaskId, callId: CallId): StepRecord | null {
    const r = this.db.sql.prepare("SELECT row FROM steps WHERE task_id = ? AND call_id = ?").get(taskId, callId) as { row: string } | undefined;
    return r ? (JSON.parse(r.row) as StepRecord) : null;
  }

  all(taskId: TaskId): StepRecord[] {
    return (this.db.sql.prepare("SELECT row FROM steps WHERE task_id = ? ORDER BY call_seq").all(taskId) as Array<{ row: string }>)
      .map((r) => JSON.parse(r.row) as StepRecord);
  }

  start(rec: StepStart, at: IsoTime): StepRecord {
    const prev = this.get(rec.taskId, rec.callId);
    const r: StepRecord = { ...rec, state: "started", attempts: (prev?.attempts ?? 0) + 1, startedAt: at, origin: "live" };
    this.put(r);
    return r;
  }

  finish(taskId: TaskId, callId: CallId, status: ToolResultStatus, resultSeq: Seq, resultPath: string | null, at: IsoTime): void {
    const r = this.get(taskId, callId);
    if (!r) throw new Error(`step not found: ${taskId}/${callId}`);
    r.state = status === "ok" ? "committed" : status === "unknown" ? "unknown" : "failed";
    r.resultSeq = resultSeq;
    if (resultPath !== null) r.resultPath = resultPath;
    if (r.state === "committed") r.committedAt = at;
    this.put(r);
  }

  reconciled(taskId: TaskId, callId: CallId, outcome: "ok" | "error", reconcileSeq: Seq, at: IsoTime): void {
    const r = this.get(taskId, callId);
    if (!r) throw new Error(`step not found: ${taskId}/${callId}`);
    r.state = outcome === "ok" ? "committed" : "failed";
    r.reconcileSeq = reconcileSeq;
    if (outcome === "ok") r.committedAt = at;
    this.put(r);
  }

  open(taskId: TaskId): StepRecord[] {
    return this.all(taskId).filter((r) => r.state === "started");
  }
  unresolved(taskId: TaskId): StepRecord[] {
    return this.all(taskId).filter((r) => r.state === "unknown");
  }

  committed(taskId: TaskId): StepRecord[] {
    return this.all(taskId).filter((r) => r.state === "committed");
  }

  rebuild(taskId: TaskId, log: LogWriter): { replayed: number; droppedPending: number; interrupted: CallId[] } {
    const evs = log.events(taskId);
    const calls = new Map<string, LoggedEvent>();
    for (const e of evs) if (e.type === "tool_call") calls.set(String(e["call_id"]), e);
    const interrupted: CallId[] = [];
    let dropped = 0;
    let replayed = 0;
    this.db.tx(() => {
      for (const r of this.all(taskId)) {
        if (!calls.has(r.callId)) {
          this.db.sql.prepare("DELETE FROM steps WHERE task_id = ? AND call_id = ?").run(taskId, r.callId);
          dropped++;
        }
      }
      for (const [callId, call] of calls) {
        const have = this.get(taskId, callId);
        let state: StepState = "started";
        let hasResult = false;
        let resultSeq: Seq | undefined;
        let resultPath: string | undefined;
        let reconcileSeq: Seq | undefined;
        for (const e of evs) {
          if (e["call_id"] !== callId) continue;
          if (e.type === "tool_result") {
            const st = e["status"] as ToolResultStatus;
            state = st === "ok" ? "committed" : st === "unknown" ? "unknown" : "failed";
            hasResult = true;
            resultSeq = e.seq;
            if (typeof e["output_ref"] === "string") resultPath = e["output_ref"];
          } else if (e.type === "reconcile") {
            state = e["outcome"] === "ok" ? "committed" : "failed";
            hasResult = true;
            reconcileSeq = e.seq;
          }
        }
        if (!hasResult) interrupted.push(callId);
        const base: StepRecord = have ?? {
          taskId, callId, stepRef: (call["step_ref"] as string | undefined) ?? null, caseId: (call["case_id"] as string | undefined) ?? null,
          toolName: String(call["tool"]), argsHash: "", risk: call["risk"] as StepRecord["risk"], effect: "read",
          idempotencyKey: "", approvalTokenId: (call["approval_token_id"] as string | null | undefined) ?? null,
          state: "started", callSeq: call.seq, attempts: 1, startedAt: call.ts,
          origin: "rebuilt",
        };
        if (!have || have.state !== state || have.resultSeq !== resultSeq) {
          const r: StepRecord = { ...base, state, callSeq: call.seq };
          if (resultSeq !== undefined) r.resultSeq = resultSeq;
          if (resultPath !== undefined) r.resultPath = resultPath;
          if (reconcileSeq !== undefined) r.reconcileSeq = reconcileSeq;
          this.put(r);
          replayed++;
        }
      }
    });
    return { replayed, droppedPending: dropped, interrupted };
  }
}
