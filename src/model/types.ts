// Model request, event and error types.
import type { AttemptId, BudgetKey, BudgetStore, IsoTime, LoopMessage, LoopToolSpec, TaskId, ToolCall } from "../types.ts";
export type { AttemptId, BudgetKey, BudgetStore, IsoTime, LoopMessage, LoopToolSpec, TaskId, ToolCall };

export type Effort = "provider-default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ProviderId = "anthropic" | "openai" | "google" | "fake";
export interface ModelRef { provider: string; model: string; effort: string | null }
export type UsageMode = "high" | "balanced" | "saver";

export type ModelPurpose =
  | "main_turn" | "worker_turn" | "template_fill" | "draft_write" | "study_sheet" | "minutes_extract" | "register_rewrite"
  | "tone_preview" | "compaction" | "prewarm" | "review";

export interface OpaqueReasoning {
  origin: { provider: string; model: string };
  providerMetadata: Record<string, unknown>;
  redacted: boolean;

  boundPrefix?: string;
}
export type Part =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; opaque: OpaqueReasoning }
  | { kind: "tool_call"; call: ToolCall; opaque?: OpaqueReasoning };

export interface ModelRequest {
  model: ModelRef;
  system: string;
  messages: LoopMessage[];

  tools: LoopToolSpec[];
  taskId: TaskId;
  attemptId: AttemptId;
  maxOutputTokens: number;
  purpose: ModelPurpose;
  mode?: UsageMode | null;
  zones?: Array<{ zone: string; text: string }>;
  zoneHashes?: Record<string, string> | null;
}

export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }

export type FinishReason = "stop" | "tool_calls" | "length" | "refusal" | "error";
export type ModelErrorKind =
  | "auth" | "rate_limit" | "overloaded" | "timeout_before_first_chunk" | "network" | "context_length"
  | "invalid_request" | "tool_args_unparsable" | "unknown_tool_name" | "unsupported_input" | "budget" | "aborted" | "unknown";
export interface ModelError {
  kind: ModelErrorKind;
  httpStatus?: number;

  providerCode?: string;
  retriedTimes: number;
  beforeFirstOutput: boolean;

  unknownToolNames?: string[];

  budget?: { scope: "day" | "month" | "task" | "unset"; period: string | null };
}

export interface CostResult { cost_mkrw: number; price_ref: string; estimated: boolean }

export interface CacheReport {
  zoneHashes: Record<string, string> | null;
  toolsHash: string;
  inputTokens: { noCache: number | null; cacheRead: number | null; cacheWrite: number | null };
  hitRatio: number | null;
  defect: null | { kind: "miss_unchanged_prefix" } | { kind: "tools_changed" } | { kind: "not_reported" };
}

export interface R10ModelCallEvent {
  type: "model_call"; provider: string; model: string; purpose: string;
  input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number;
  cost_mkrw: number; price_ref: string; usage_estimated: boolean;
  mode?: UsageMode | null; effort?: string | null;

  provider_error_type?: string | null; provider_error_message?: string | null;

  thinking_dropped_prefix?: number; thinking_dropped_provider?: number; thinking_stripped_retry?: boolean;
}

export interface ThinkingReplayEvent {
  event: "binding_miss" | "replay_disabled" | "binding_unsupported" | "openai_reasoning_off";
  provider: string; model: string; purpose: string;

  ourDrops: number; providerDrops: number; strippedRetries: number;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_block"; part: Extract<Part, { kind: "thinking" }> }
  | { type: "tool_input_delta"; callId: string; toolName: string; delta: string }
  | { type: "tool_call"; call: ToolCall; opaque?: OpaqueReasoning }
  | { type: "retry"; reason: ModelErrorKind; attempt: number; maxAttempts: number; delayMs: number }
  | { type: "finish"; reason: FinishReason; usage: Usage; cost: CostResult; cache: CacheReport;

      record?: R10ModelCallEvent; message?: string; error?: ModelError };

export interface ModelAdapter {
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
