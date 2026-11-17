// Streaming model adapter: budget reservation before the call, settle after, retries only before first output.
import { APICallError, type LanguageModelV4, type LanguageModelV4StreamPart, type LanguageModelV4Usage } from "@ai-sdk/provider";
import { GuardedFetchError } from "./guarded-fetch.ts";
import type { FundingSource, LedgerSink } from "./ledger.ts";
import type { PriceBook } from "./prices.ts";
import { estimateInputTokens, toV4 } from "./to-v4.ts";
import { budgetPeriod } from "../util/time.ts";
import type {
  BudgetKey, BudgetStore, CacheReport, CostResult, FinishReason, ModelAdapter, ModelError, ModelErrorKind, ModelEvent, ModelRef, ModelRequest,
  OpaqueReasoning, R10ModelCallEvent, ThinkingReplayEvent, Usage,
} from "./types.ts";

export const THINKING_MISS_LIMIT = 3;

export function mergeProviderMetadata(a: Record<string, unknown>, b: unknown): Record<string, unknown> {
  if (b === null || typeof b !== "object") return a;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (v === undefined) continue;
    const prev = out[k];
    if (prev !== null && typeof prev === "object" && v !== null && typeof v === "object" && !Array.isArray(v)) {
      const inner: Record<string, unknown> = { ...(prev as Record<string, unknown>) };
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) if (iv !== undefined) inner[ik] = iv;
      out[k] = inner;
    } else out[k] = v;
  }
  return out;
}

function providerThinkingDrops(meta: unknown): number {
  const a = (meta as { anthropic?: { inputTransformations?: unknown } } | undefined)?.anthropic?.inputTransformations;
  return Array.isArray(a) ? a.filter((t) => (t as { type?: unknown } | null)?.type === "thinking_dropped").length : 0;
}

const BINDING_UNSUPPORTED_RE = /block_binding|thinking-binding-controls/;

export type ResolveModel = (ref: ModelRef) => Promise<{ ok: true; model: LanguageModelV4 } | { ok: false; code: string }>;

export interface ModelAdapterDeps {
  budget: BudgetStore;

  prices: PriceBook | (() => PriceBook);
  ledger: LedgerSink;
  resolveModel: ResolveModel;

  retrySameModel?: number;

  firstChunkTimeoutMs?: number;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;

  funding?: (provider: string) => FundingSource;

  krwRateLabel?: string | null;

  onReasoningDropped?: (count: number, req: ModelRequest) => void;

  onThinkingReplay?: (e: ThinkingReplayEvent) => void;
}

const MAX_BACKOFF_MS = 30_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultFunding(provider: string): FundingSource {
  return provider === "anthropic" ? "anthropic-credit" : provider === "fake" ? "none" : "card";
}

export function budgetKeys(req: ModelRequest, at: Date): BudgetKey[] {
  const p = budgetPeriod(at);
  const span: BudgetKey[] = [{ scope: "day", id: p.day }, { scope: "month", id: p.month }];
  return req.taskId === "app" ? span : [{ scope: "task", id: req.taskId }, ...span];
}

interface Classified { kind: ModelErrorKind; httpStatus?: number; code?: string; retryAfterMs?: number; retryable: boolean }

function findInChain<T>(err: unknown, pred: (e: unknown) => e is T): T | null {
  let e: unknown = err;
  for (let i = 0; i < 5 && e != null; i++) {
    if (pred(e)) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

export function classifyError(err: unknown, aborted: boolean, timedOut: boolean): Classified {
  if (timedOut) return { kind: "timeout_before_first_chunk", retryable: true };
  if (aborted) return { kind: "aborted", retryable: false };
  const g = findInChain(err, (e): e is GuardedFetchError => e instanceof GuardedFetchError);
  if (g) return { kind: "invalid_request", code: g.code, retryable: false };
  const api = findInChain(err, (e): e is APICallError => APICallError.isInstance(e));
  if (api) {
    const s = api.statusCode;
    const ra = api.responseHeaders?.["retry-after"];
    const retryAfterMs = ra !== undefined && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined;
    const base = { ...(s !== undefined ? { httpStatus: s } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    if (s === undefined) return { ...base, kind: "network", retryable: true };
    if (s === 401 || s === 403) return { ...base, kind: "auth", retryable: false };
    if (s === 429) return { ...base, kind: "rate_limit", retryable: true };
    if (s === 413) return { ...base, kind: "context_length", retryable: false };
    if (s === 408) return { ...base, kind: "timeout_before_first_chunk", retryable: true };
    if (s >= 500) return { ...base, kind: "overloaded", retryable: true };
    return { ...base, kind: "invalid_request", retryable: false };
  }
  if (err instanceof TypeError) return { kind: "network", retryable: true };
  return { kind: "unknown", retryable: false };
}

export interface ProviderErrorInfo { type: string | null; message: string | null }

export const PROVIDER_ERROR_MESSAGE_MAX = 300;

export function sanitizeProviderText(s: string, max: number): string {
  const masked = s
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "AIza***")
    .replace(/(Bearer\s+)[^\s"',]+/gi, "$1***")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  const cps = [...masked];
  return cps.length > max ? cps.slice(0, max).join("") + "…" : masked;
}

function pickError(o: unknown): ProviderErrorInfo | null {
  if (o === null || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  // anthropic {type:"error", error:{type,message}} · openai {error:{type,message}} · google {error:{status,message}}
  const inner = rec["error"] !== null && typeof rec["error"] === "object" ? (rec["error"] as Record<string, unknown>) : rec;
  const t = typeof inner["type"] === "string" && inner["type"] !== "error" ? inner["type"] : typeof inner["status"] === "string" ? inner["status"] : null;
  const m = typeof inner["message"] === "string" ? inner["message"] : null;
  if (t === null && m === null) return null;
  return {
    type: t === null ? null : /^[A-Za-z0-9_.-]{1,64}$/.test(t) ? t : "other",
    message: m === null ? null : sanitizeProviderText(m, PROVIDER_ERROR_MESSAGE_MAX),
  };
}

export function extractProviderError(err: unknown): ProviderErrorInfo | null {
  const api = findInChain(err, (e): e is APICallError => APICallError.isInstance(e));
  if (api) {
    if (typeof api.responseBody === "string") {
      try {
        const got = pickError(JSON.parse(api.responseBody));
        if (got) return got;
      } catch {
      }
    }
    return pickError(api.data);
  }

  if (err !== null && typeof err === "object" && !(err instanceof Error)) return pickError(err);
  return null;
}

export const UNKNOWN_TOOL_NAMES_MAX = 3;
export function cleanUnknownToolName(s: string): string {
  return [...s.replace(/[\u0000-\u001f\u007f]/g, "")].slice(0, 64).join("");
}

export function providerErrorBasis(p: ProviderErrorInfo): string {
  return ` provider_error:${p.type ?? "?"}${p.message !== null ? ` "${p.message.replace(/"/g, "'")}"` : ""}`;
}

function mapFinish(unified: string): FinishReason {
  switch (unified) {
    case "tool-calls": return "tool_calls";
    case "length": return "length";
    case "content-filter": return "refusal";
    case "error": return "error";
    default: return "stop";                    // stop·other
  }
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

export function createModelAdapter(deps: ModelAdapterDeps): ModelAdapter {
  const retries = deps.retrySameModel ?? 2;
  const firstChunkTimeoutMs = deps.firstChunkTimeoutMs ?? 60_000;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const funding = deps.funding ?? defaultFunding;

  const prices = (): PriceBook => (typeof deps.prices === "function" ? deps.prices() : deps.prices);
  const lastByAttempt = new Map<string, { toolsHash: string; zoneKey: string }>();

  let replayOn = true;
  let netOn = true;
  let missCount = 0;

  let openaiReplayOn = true;
  const totals ={ ourDrops: 0, providerDrops: 0, strippedRetries: 0 };
  const emitted = new Set<ThinkingReplayEvent["event"]>();
  const emitReplay = (event: ThinkingReplayEvent["event"], req: ModelRequest) => {
    if (emitted.has(event)) return;
    emitted.add(event);
    deps.onThinkingReplay?.({ event, provider: req.model.provider, model: req.model.model, purpose: req.purpose, ...totals });
  };

  const miss = (req: ModelRequest) => {
    missCount++;
    emitReplay("binding_miss", req);
    if (missCount >= THINKING_MISS_LIMIT && replayOn) {
      replayOn = false;
      netOn = false;
      emitReplay("replay_disabled", req);
    }
  };

  return {
    async *stream(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
      const { provider, model } = req.model;
      let conv = toV4(req, { replayThinking: replayOn, safetyNet: netOn, replayOpenaiReasoning: openaiReplayOn });
      const firstConv = conv;
      totals.ourDrops += conv.droppedPrefix;
      if (conv.droppedReasoning > 0) deps.onReasoningDropped?.(conv.droppedReasoning, req);

      const emptyCache: CacheReport = { zoneHashes: req.zoneHashes ?? null, toolsHash: conv.toolsHash, inputTokens: { noCache: null, cacheRead: null, cacheWrite: null }, hitRatio: null, defect: null };
      const noCost = (ref: string): CostResult => ({ cost_mkrw: 0, price_ref: ref, estimated: false });
      const refuse = (kind: ModelErrorKind, code: string, message?: string, budget?: ModelError["budget"]): ModelEvent => ({
        type: "finish", reason: "error", usage: ZERO_USAGE, cost: noCost(prices().priceRef(provider, model)), cache: emptyCache,
        error: { kind, providerCode: code, retriedTimes: 0, beforeFirstOutput: true, ...(budget ? { budget } : {}) }, ...(message !== undefined ? { message } : {}),
      });

      if (conv.nameError !== null) {
        yield refuse("invalid_request", conv.nameError);
        return;
      }

      const fromWire = (n: string): string | null => conv.toolNames.fromWire.get(n) ?? null;

      const inputEstimate = estimateInputTokens(conv.options);
      const worst = prices().worstCase(provider, model, inputEstimate, req.maxOutputTokens);
      if (!worst) {
        yield refuse("invalid_request", "price_unknown");
        return;
      }

      const reservedAt = now();
      const reservation = deps.budget.reserve(budgetKeys(req, reservedAt), worst.cost_mkrw, reservedAt.toISOString());
      if (!reservation.ok) {
        yield refuse("budget", reservation.scope === "unset" ? "cap_not_set" : "cap_exceeded", undefined, { scope: reservation.scope, period: reservation.period });
        return;
      }

      const resolved = await deps.resolveModel(req.model);
      if (!resolved.ok) {
        deps.budget.release(reservation.reservationId);
        yield refuse("invalid_request", resolved.code);
        return;
      }

      let calls = 0;
      let retried = 0;
      let firstOutput = false;
      let usageV4: LanguageModelV4Usage | null = null;
      let finishUnified: string | null = null;
      let finishRaw: string | undefined;
      let failure: Classified | null = null;
      let providerError: ProviderErrorInfo | null = null;
      let outChars = 0;
      let unparsable = 0;
      let unknownTool = 0;
      const unknownNames: string[] = [];
      const reasoningText = new Map<string, string>();
      const reasoningMeta = new Map<string, Record<string, unknown>>();
      const toolNames = new Map<string, string>();
      let strippedRetry = false;

      let strippedCounts = false;
      let providerDrops = 0;

      attempts: for (;;) {
        calls++;
        const inner = new AbortController();
        let timedOut = false;
        const onOuterAbort = () => inner.abort(signal.reason);
        signal.addEventListener("abort", onOuterAbort, { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          inner.abort(new Error("first_chunk_timeout"));
        }, firstChunkTimeoutMs);
        let gotChunk = false;
        try {
          if (signal.aborted) throw signal.reason;
          const res = await resolved.model.doStream({ ...conv.options, abortSignal: inner.signal });
          const reader = res.stream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (!gotChunk) {
              gotChunk = true;
              clearTimeout(timer);
            }
            if (done) break;
            const part: LanguageModelV4StreamPart = value;
            switch (part.type) {
              case "text-delta":
                firstOutput = true;
                outChars += part.delta.length;
                yield { type: "text_delta", text: part.delta };
                break;
              case "reasoning-start":
                reasoningMeta.set(part.id, mergeProviderMetadata({}, part.providerMetadata));
                break;
              case "reasoning-delta":
                reasoningMeta.set(part.id, mergeProviderMetadata(reasoningMeta.get(part.id) ?? {}, part.providerMetadata));
                firstOutput = true;
                outChars += part.delta.length;
                reasoningText.set(part.id, (reasoningText.get(part.id) ?? "") + part.delta);
                yield { type: "thinking_delta", text: part.delta };
                break;
              case "reasoning-end": {
                firstOutput = true;
                const meta = mergeProviderMetadata(reasoningMeta.get(part.id) ?? {}, part.providerMetadata);
                const redacted = (meta["anthropic"] as { redactedData?: unknown } | undefined)?.redactedData !== undefined;
                const opaque: OpaqueReasoning = { origin: { provider, model }, providerMetadata: meta, redacted, ...(provider === "anthropic" ? { boundPrefix: conv.prefixHash } : {}) };
                yield { type: "thinking_block", part: { kind: "thinking", text: reasoningText.get(part.id) ?? "", opaque } };
                break;
              }
              case "tool-input-start":
                toolNames.set(part.id, fromWire(part.toolName) ?? "");
                break;
              case "tool-input-delta":
                firstOutput = true;
                outChars += part.delta.length;
                yield { type: "tool_input_delta", callId: part.id, toolName: toolNames.get(part.id) ?? "", delta: part.delta };
                break;
              case "tool-call": {
                firstOutput = true;
                const name = fromWire(part.toolName);
                if (name === null) {
                  unknownTool++;
                  const n = cleanUnknownToolName(part.toolName);
                  if (unknownNames.length < UNKNOWN_TOOL_NAMES_MAX && !unknownNames.includes(n)) unknownNames.push(n);
                  break;
                }
                let args: unknown;
                try {
                  args = part.input.trim() === "" ? {} : JSON.parse(part.input);
                } catch {
                  unparsable++;
                  break;
                }
                const opaque: OpaqueReasoning | undefined = part.providerMetadata
                  ? { origin: { provider, model }, providerMetadata: part.providerMetadata as Record<string, unknown>, redacted: false }
                  : undefined;
                yield { type: "tool_call", call: { id: part.toolCallId, name, args }, ...(opaque ? { opaque } : {}) };
                break;
              }
              case "finish":
                usageV4 = part.usage;
                finishUnified = part.finishReason.unified;
                finishRaw = part.finishReason.raw;
                if (provider === "anthropic") providerDrops = providerThinkingDrops(part.providerMetadata);
                break;
              case "error":
                throw part.error;
              default:
                break;
            }
          }
          break attempts;
        } catch (err) {
          const c = classifyError(err, signal.aborted, timedOut);
          providerError = extractProviderError(err);

          if (!firstOutput && !strippedRetry && provider === "anthropic" && c.kind === "invalid_request" && c.httpStatus === 400
            && (conv.carriedThinking > 0 || conv.safetyNet) && !signal.aborted) {
            const unsupported = conv.safetyNet && BINDING_UNSUPPORTED_RE.test(providerError?.message ?? "");
            if (unsupported && netOn) {
              netOn = false;
              emitReplay("binding_unsupported", req);
            }
            strippedRetry = true;
            strippedCounts = !unsupported && !conv.keptMismatchedAwaiting;
            totals.strippedRetries++;
            conv = toV4(req, { replayThinking: false, safetyNet: false });
            continue attempts;
          }

          if (!firstOutput && !strippedRetry && provider === "openai" && c.kind === "invalid_request" && c.httpStatus === 400
            && conv.carriedOpenaiReasoning > 0 && !signal.aborted) {
            strippedRetry = true;
            conv = toV4(req, { replayThinking: replayOn, safetyNet: netOn, replayOpenaiReasoning: false });
            continue attempts;
          }
          if (!firstOutput && c.retryable && retried < retries && !signal.aborted) {
            retried++;
            const backoff = c.retryAfterMs ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (retried - 1));
            const delayMs = Math.min(backoff, MAX_BACKOFF_MS);

            yield { type: "retry", reason: c.kind, attempt: retried, maxAttempts: retries, delayMs };
            try {
              await sleep(delayMs, signal);
            } catch {
              failure = { kind: "aborted", retryable: false };
              break attempts;
            }
            continue attempts;
          }
          failure = c;
          break attempts;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", onOuterAbort);
        }
      }

      if (provider === "openai" && strippedRetry && !failure && openaiReplayOn) {
        openaiReplayOn = false;
        emitReplay("openai_reasoning_off", req);
      }
      if (provider === "anthropic" && !failure) {
        if (providerDrops > 0) totals.providerDrops += providerDrops;
        if (strippedRetry && strippedCounts) miss(req);
        if (providerDrops > 0 && !conv.keptMismatchedAwaiting) miss(req);
      }

      const u = usageV4 as LanguageModelV4Usage | null;
      const cr = u?.inputTokens.cacheRead;
      const cw = u?.inputTokens.cacheWrite;
      const noCacheReported = u?.inputTokens.noCache ?? (u?.inputTokens.total !== undefined ? u.inputTokens.total - (cr ?? 0) - (cw ?? 0) : undefined);
      const outReported = u?.outputTokens.total;
      const usageEstimated = noCacheReported === undefined || outReported === undefined;
      const usage: Usage = {
        inputTokens: noCacheReported ?? (failure && !firstOutput ? 0 : inputEstimate),
        outputTokens: outReported ?? outChars,
        cacheReadTokens: cr ?? 0,
        cacheWriteTokens: cw ?? 0,
        reasoningTokens: u?.outputTokens.reasoning ?? 0,
      };
      const priced = prices().cost(provider, model, { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens });
      const cost: CostResult = priced
        ? { cost_mkrw: priced.cost_mkrw, price_ref: priced.price_ref, estimated: priced.estimated || usageEstimated }
        : { cost_mkrw: worst.cost_mkrw, price_ref: worst.price_ref, estimated: true };
      deps.budget.settle(reservation.reservationId, cost.cost_mkrw, now().toISOString());

      const zoneKey = JSON.stringify(req.zoneHashes ?? null);
      const prev = lastByAttempt.get(req.attemptId);
      lastByAttempt.set(req.attemptId, { toolsHash: conv.toolsHash, zoneKey });
      const denom = (noCacheReported ?? 0) + (cr ?? 0) + (cw ?? 0);
      const cache: CacheReport = {
        zoneHashes: req.zoneHashes ?? null,
        toolsHash: conv.toolsHash,
        inputTokens: { noCache: noCacheReported ?? null, cacheRead: cr ?? null, cacheWrite: cw ?? null },
        hitRatio: cr !== undefined && noCacheReported !== undefined && denom > 0 ? cr / denom : null,
        defect:
          prev === undefined ? null
          : prev.toolsHash !== conv.toolsHash ? { kind: "tools_changed" }
          : cr === undefined ? { kind: "not_reported" }
          : prev.zoneKey === zoneKey && cr === 0 ? { kind: "miss_unchanged_prefix" }
          : null,
      };

      const record: R10ModelCallEvent = {
        type: "model_call", provider, model, purpose: req.purpose,
        input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        ...(cr !== undefined ? { cache_read_tokens: cr } : {}), ...(cw !== undefined ? { cache_write_tokens: cw } : {}),
        cost_mkrw: cost.cost_mkrw, price_ref: cost.price_ref, usage_estimated: cost.estimated,
        mode: req.mode ?? null, effort: req.model.effort,
        ...(failure && providerError ? { provider_error_type: providerError.type, provider_error_message: providerError.message } : {}),
        ...(provider === "anthropic" ? { thinking_dropped_prefix: firstConv.droppedPrefix, thinking_dropped_provider: providerDrops, thinking_stripped_retry: strippedRetry } : {}),
      };
      deps.ledger.append({
        date: now().toISOString().replace(/\.\d{3}Z$/, "Z"),
        runId: `${req.taskId}/${req.attemptId}`,
        purpose: req.purpose,
        provider, model, calls,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: cw ?? null,
        usdEstimateMicro: worst.usd_micro,
        usdActualMicro: priced ? priced.usd_micro : null,
        krwRate: provider === "fake" ? null : (deps.krwRateLabel ?? (priced ? `${priced.fx.mkrw_per_usd / 1000}(${priced.fx.source ?? "no source"})` : null)),
        krwActualMkrw: cost.cost_mkrw,
        funding: funding(provider),
        basis: `${cost.price_ref}${cost.estimated ? " usage_estimated" : ""}${failure ? ` error:${failure.kind}` : unknownTool > 0 ? " error:unknown_tool_name" : ""}${failure && providerError ? providerErrorBasis(providerError) : ""}`,
      });

      // 6. finish
      let reason: FinishReason;
      let error: ModelError | undefined;
      let message: string | undefined;
      if (failure) {
        reason = "error";
        error = {
          kind: failure.kind, retriedTimes: retried, beforeFirstOutput: !firstOutput,
          ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
          ...(failure.code !== undefined ? { providerCode: failure.code } : {}),
        };
      } else if (unknownTool > 0) {
        reason = "error";
        error = { kind: "unknown_tool_name", retriedTimes: retried, beforeFirstOutput: false, providerCode: `unknown_tool_name:${unknownTool}`, unknownToolNames: unknownNames };
      } else if (unparsable > 0) {
        reason = "error";
        error = { kind: "tool_args_unparsable", retriedTimes: retried, beforeFirstOutput: false, providerCode: `unparsable:${unparsable}` };
      } else {
        reason = mapFinish(finishUnified ?? "other");
        if (finishUnified === "other" || finishUnified === null) message = `finish_raw:${finishRaw ?? "none"}`;
      }
      yield { type: "finish", reason, usage, cost, cache, record, ...(message !== undefined ? { message } : {}), ...(error ? { error } : {}) };
    },
  };
}
