// Shared types for the task queue, step journal, event log and budget store.
import type { ToolCall, ToolOutcome, ToolSpec, TaskOrigin } from "./gate/types.ts";
import type { ModelRef, Part } from "./model/types.ts";

export type { ToolCall, ToolOutcome, ToolSpec, TaskOrigin } from "./gate/types.ts";
export type { ModelRef, ModelRequest, ModelEvent, ModelAdapter, Usage, CostResult, CacheReport, Part, R10ModelCallEvent, ModelPurpose } from "./model/types.ts";

export type Id = string;
export type TaskId = Id;
export type AttemptId = Id;
export type CaseId = Id;
export type CallId = Id;
export type CardId = Id;
export type Seq = number;
export type IsoTime = string;
export type Risk = ToolSpec["risk"];

export type TaskState = "planned" | "running" | "waiting" | "done" | "failed" | "stopped" | "canceled";
export type TaskEndState = "done" | "failed" | "stopped" | "canceled";
/** "observe" tasks never take a run slot. */
export type TaskKind = "task" | "scheduled" | "observe";

export type WaitReason =
  | { kind: "ask_user"; cardId: CardId }
  | { kind: "gate_block"; rule: string; cardId: CardId }
  | { kind: "all_cases_waiting"; caseIds: CaseId[] }
  | { kind: "unknown_outcome"; callId: CallId }
  | { kind: "model_refused" }
  | { kind: "budget"; capMkrw: number | null; spentMkrw: number };
export type StopReason =
  | { kind: "gate_terminal"; rule: string; reason: string }
  | { kind: "tool_error_repeated"; tool: string; errorKind: string; count: number }
  | { kind: "plan_ambiguous"; reason: "duplicate_step_id" };
export type CancelReason = { kind: "user_canceled" };
export type FailReason =
  | { kind: "max_turns" }
  | { kind: "tool_error"; callId: CallId; message: string }
  | { kind: "model_error"; message: string; providerCode?: string }
  | { kind: "retry_exhausted"; callId: CallId };
export type Why = WaitReason | StopReason | CancelReason | FailReason;

export interface TaskRow {
  id: TaskId;
  attemptId: AttemptId;
  prevTaskId?: TaskId;
  title: string;
  planId: string;
  planSha256: string;
  kind: TaskKind;
  origin: TaskOrigin;
  usesBrowser: boolean;
  state: TaskState;
  why: Why | null;
  waitingCases: CaseId[];
  caseNotBefore: Record<CaseId, IsoTime>;
  model: ModelRef;
  lastSeq: Seq;
  leaseUntil?: IsoTime;
  leaseToken?: string;
  priority: number;
  notBefore?: IsoTime;
  parentTaskId?: TaskId;
  parentCardId?: CardId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}
export type NewTask = Pick<TaskRow, "title" | "planId" | "planSha256" | "kind" | "origin" | "usesBrowser" | "model">
  & Partial<Pick<TaskRow, "prevTaskId" | "priority" | "notBefore" | "attemptId" | "parentTaskId" | "parentCardId">>;

export interface ConcurrencyLimits { maxRunning: number; maxBrowser: 1 }

export type StepState = "started" | "committed" | "failed" | "unknown";
export type ToolResultStatus = ToolOutcome["status"];
export interface StepRecord {
  taskId: TaskId; callId: CallId;
  stepRef: string | null; caseId: CaseId | null;
  toolName: string; argsHash: string;
  risk: Risk; effect: ToolSpec["effect"];
  idempotencyKey: string;
  approvalTokenId: string | null;
  state: StepState;
  callSeq: Seq;
  resultSeq?: Seq;
  resultPath?: string;
  reconcileSeq?: Seq;
  attempts: number;
  startedAt: IsoTime; committedAt?: IsoTime;
  /** "rebuilt" = recreated from the event log after a crash. */
  origin?: "live" | "rebuilt";
}

export interface BudgetKey { scope: "task" | "day" | "month"; id: string }
/** Refusal scope: unset (no cap configured) > task > month > day. `period` is the day/month key, null for task/unset. */
export type BudgetRefusal = { ok: false; scope: "day" | "month" | "task" | "unset"; period: string | null; capMkrw: number | null; spentMkrw: number };
export interface BudgetStore {
  reserve(keys: BudgetKey[], estimateMkrw: number, at: IsoTime): { ok: true; reservationId: string } | BudgetRefusal;
  settle(reservationId: string, actualMkrw: number, at: IsoTime): void;
  release(reservationId: string): void;
  spent(key: BudgetKey): { capMkrw: number | null; spentMkrw: number };
}

export type LoopMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[];
      /** Raw reasoning parts. Kept in memory only; never logged or stored. */
      parts?: Part[] }
  | { role: "tool"; callId: string; content: string; isError: boolean }
  | { role: "steering"; content: string; from: "main" | "user" };

/** Tool declaration seen by the model: gate ToolSpec plus description and JSON schema. */
export interface LoopToolSpec extends ToolSpec {
  description: string;
  argsSchema: Record<string, unknown>;
  holdMs?: number;
}

export type Stage = 1 | 2 | 3 | 4;
export interface Money { currency: "KRW" | "USD"; minor: number }

export type EventBody = { type: string; actor?: "main" | "worker" | "tool_layer" | "user" | "app"; ts?: IsoTime } & Record<string, unknown>;
export type LoggedEvent = Record<string, unknown> & { schema: "agent-guardrails.log/v0"; task_id: string; seq: Seq; ts: IsoTime; actor: string; type: string; prev_hash: string; hash: string };
