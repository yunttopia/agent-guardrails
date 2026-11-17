// Scriptable fake language model for tests.
import { APICallError, type LanguageModelV4, type LanguageModelV4CallOptions, type LanguageModelV4StreamPart } from "@ai-sdk/provider";

export type FakeReasoningPart = {
  reasoning: string; signature?: string; metaAt?: "start" | "delta" | "end";
  meta?: { start?: Record<string, unknown>; delta?: Record<string, unknown>; end?: Record<string, unknown> };
};
export type FakePart = { text: string } | FakeReasoningPart | { toolCall: { name: string; args: unknown } } | { rawToolCall: { name: string; input: string } };

export type FakeTurn =
  | {
      kind: "reply";
      parts: FakePart[];

      finish?: "stop" | "tool-calls" | "length" | "content-filter" | "other";

      usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number } | null;

      failAfterParts?: number;
    }
  | { kind: "http_error"; status: number; retryAfterSec?: number }
  | { kind: "network_error" };

export interface FakeLanguageModel extends LanguageModelV4 {
  readonly calls: LanguageModelV4CallOptions[];

  remaining(): number;
}

const FAKE_URL = "https://fake.invalid/v1/messages";

function* partsToStream(turn: Extract<FakeTurn, { kind: "reply" }>): Generator<LanguageModelV4StreamPart> {
  let n = 0;
  let hasTool = false;
  for (const p of turn.parts) {
    if (turn.failAfterParts !== undefined && n >= turn.failAfterParts) {
      yield { type: "error", error: new APICallError({ message: "fake stream cut", url: FAKE_URL, requestBodyValues: {}, statusCode: 500, isRetryable: true }) };
      return;
    }
    const id = `p${n}`;
    if ("text" in p) {
      yield { type: "text-start", id };
      yield { type: "text-delta", id, delta: p.text };
      yield { type: "text-end", id };
    } else if ("reasoning" in p) {
      const sig = { fake: { signature: p.signature ?? `sig-${n}` } };
      const at = p.metaAt ?? "delta";
      const metaFor = (where: "start" | "delta" | "end") => (p.meta ? p.meta[where] : at === where ? sig : undefined);
      const ms = metaFor("start");
      const md = metaFor("delta");
      const me = metaFor("end");
      yield { type: "reasoning-start", id, ...(ms ? { providerMetadata: ms as never } : {}) };
      yield { type: "reasoning-delta", id, delta: p.reasoning, ...(md ? { providerMetadata: md as never } : {}) };
      yield { type: "reasoning-end", id, ...(me ? { providerMetadata: me as never } : {}) };
    } else {
      hasTool = true;
      const name = "toolCall" in p ? p.toolCall.name : p.rawToolCall.name;
      const input = "toolCall" in p ? JSON.stringify(p.toolCall.args) : p.rawToolCall.input;
      const callId = `fake_call_${n}`;
      yield { type: "tool-input-start", id: callId, toolName: name };
      yield { type: "tool-input-delta", id: callId, delta: input };
      yield { type: "tool-input-end", id: callId };
      yield { type: "tool-call", toolCallId: callId, toolName: name, input };
    }
    n++;
  }
  const chars = turn.parts.reduce((s, p) => s + ("text" in p ? p.text.length : "reasoning" in p ? p.reasoning.length : 10), 0);
  const u = turn.usage === undefined ? { input: 100, output: Math.max(1, Math.ceil(chars / 2)) } : turn.usage;
  yield {
    type: "finish",
    finishReason: { unified: turn.finish ?? (hasTool ? "tool-calls" : "stop"), raw: turn.finish ?? (hasTool ? "tool_use" : "end_turn") },
    usage:
      u === null
        ? { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } }
        : {
            inputTokens: { total: u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), noCache: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
            outputTokens: { total: u.output, text: u.output - (u.reasoning ?? 0), reasoning: u.reasoning },
          },
  };
}

export function createFakeLanguageModel(script: FakeTurn[], opts?: { modelId?: string }): FakeLanguageModel {
  const queue = [...script];
  const calls: LanguageModelV4CallOptions[] = [];
  const model: FakeLanguageModel = {
    specificationVersion: "v4",
    provider: "fake",
    modelId: opts?.modelId ?? "fake-1",
    supportedUrls: {},
    calls,
    remaining: () => queue.length,
    async doGenerate() {
      throw new Error("fake: doGenerate is not used (the adapter only calls doStream)");
    },
    async doStream(options) {
      calls.push(options);
      const turn = queue.shift();
      if (!turn) throw new Error("fake: script exhausted");
      if (turn.kind === "network_error") throw new TypeError("fetch failed");
      if (turn.kind === "http_error") {
        throw new APICallError({
          message: `fake http ${turn.status}`,
          url: FAKE_URL,
          requestBodyValues: {},
          statusCode: turn.status,
          responseHeaders: turn.retryAfterSec !== undefined ? { "retry-after": String(turn.retryAfterSec) } : {},
          isRetryable: turn.status === 429 || turn.status >= 500,
        });
      }
      const it = partsToStream(turn);
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        pull(controller) {
          if (options.abortSignal?.aborted) {
            controller.error(options.abortSignal.reason ?? new DOMException("aborted", "AbortError"));
            return;
          }
          const next = it.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
      });
      return { stream };
    },
  };
  return model;
}
