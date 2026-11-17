import { APICallError, type LanguageModelV4, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createModelAdapter } from "../../src/model/adapter.ts";
import type { FetchLike } from "../../src/model/guarded-fetch.ts";
import { createMemoryLedger } from "../../src/model/ledger.ts";
import { PriceBook, type PriceTable } from "../../src/model/prices.ts";
import { createModelResolver } from "../../src/model/resolve.ts";
import { toV4 } from "../../src/model/to-v4.ts";
import type { LoopMessage, ModelEvent, ModelRequest, Part, ThinkingReplayEvent } from "../../src/model/types.ts";
import { collect, memBudget, req, toolSpec } from "./helpers.ts";

const M = "gpt-6.1-sol";
const table: PriceTable = {
  schema: "agent-guardrails.prices/v0", version: "t", unit: "usd_micro_per_1m_tokens",
  fx: { mkrw_per_usd: 1_400_000, source: "test", checked: null },
  models: { [M]: { provider: "openai", input: 1_000_000, output: 5_000_000, cache_read: 100_000, cache_write: 1_250_000, tiers: null } },
};
function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((d, i) => `event: ${String(d["type"])}\ndata: ${JSON.stringify({ ...d, sequence_number: i })}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const resp = { id: "resp_test_r", created_at: 1794299456, model: M };
const completed = { type: "response.completed", response: { ...resp, status: "completed", incomplete_details: null, usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 59 } } };

const textTurn = () => sse([
  { type: "response.created", response: resp },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_r1" } },
  { type: "response.output_text.delta", item_id: "msg_r1", output_index: 0, content_index: 0, delta: "Thursday", logprobs: [] },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_r1" } },
  completed,
]);

const textThenError = () => sse([
  { type: "response.created", response: resp },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_r2" } },
  { type: "response.output_text.delta", item_id: "msg_r2", output_index: 0, content_index: 0, delta: "Thu", logprobs: [] },
  { type: "error", code: "server_error", message: "stream broke", param: null },
]);
const status = (s: number, message = "Invalid reasoning item.") => () =>
  new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param: null, code: null } }), { status: s, headers: { "content-type": "application/json" } });

function scripted(replies: Array<() => Response>) {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const fetchImpl: FetchLike = async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const r = replies[i++];
    if (!r) throw new Error(`fetch script exhausted (${i})`);
    return r();
  };
  return { fetchImpl, bodies, count: () => i };
}
function realAdapter(fetchImpl: FetchLike, events: ThinkingReplayEvent[]) {
  return createModelAdapter({
    budget: memBudget(1_000_000_000), ledger: createMemoryLedger(), prices: new PriceBook([table]), retrySameModel: 0,
    resolveModel: createModelResolver({ real: { enabled: true, secrets: { get: async (n) => (n === "OPENAI_API_KEY" ? "test-key-not-real-retry" : null) }, fetchImpl } }),
    onThinkingReplay: (e) => events.push(e),
  });
}
const S = () => new AbortController().signal;
const finishOf = (evs: ModelEvent[]) => {
  const f = evs.at(-1);
  if (!f || f.type !== "finish") throw new Error("no finish");
  return f;
};
const op = (itemId: string, enc: string | null, origin = { provider: "openai", model: M }): Part => ({ kind: "thinking", text: "summary", opaque: { origin, providerMetadata: { openai: { itemId, reasoningEncryptedContent: enc } }, redacted: false } });
const call: Part = { kind: "tool_call", call: { id: "call_r1", name: "note_lookup", args: { id: "A-17" } }, opaque: { origin: { provider: "openai", model: M }, providerMetadata: { openai: { itemId: "fc_r1" } }, redacted: false } };
const hist = (ps: Part[]): LoopMessage[] => [{ role: "user", content: "A-17" }, { role: "assistant", content: "", parts: ps }, { role: "tool", callId: "call_r1", content: "note A-17: Thursday", isError: false }];
const oReq = (messages: LoopMessage[]): ModelRequest =>
  req({ model: { provider: "openai", model: M, effort: "medium" }, tools: [toolSpec("note_lookup")], purpose: "main_turn", taskId: "app", attemptId: "app", messages });
const types = (b: Record<string, unknown>) => (b["input"] as Array<Record<string, unknown>>).map((x) => String(x["type"] ?? `role:${String(x["role"])}`));
const withReasoning = () => oReq(hist([op("rs_r1", "enc-r1"), call]));

describe("openai 400: retry once without reasoning", () => {
  it("R1 400 -> retry without reasoning succeeds, one event, next turn sends no reasoning (1 fetch)", async () => {
    const events: ThinkingReplayEvent[] = [];
    const s = scripted([status(400), textTurn, textTurn]);
    const a = realAdapter(s.fetchImpl, events);
    const f1 = finishOf(await collect(a.stream(withReasoning(), S())));
    expect(f1.reason).toBe("stop");
    expect(s.count()).toBe(2);
    expect(types(s.bodies[0]!)).toContain("reasoning");
    expect(types(s.bodies[1]!)).toEqual(["role:developer", "role:user", "function_call", "function_call_output"]);
    expect(s.bodies[1]!["store"]).toBe(false);
    expect(events.map((e) => e.event)).toEqual(["openai_reasoning_off"]);
    expect(events[0]).toMatchObject({ provider: "openai", model: M, purpose: "main_turn" });

    const f2 = finishOf(await collect(a.stream(withReasoning(), S())));
    expect(f2.reason).toBe("stop");
    expect(s.count()).toBe(3);
    expect(types(s.bodies[2]!)).not.toContain("reasoning");
    expect(events).toHaveLength(1);
  });

  it("R2 retry also 400 -> error (2 fetches), not disabled; next turn sends reasoning again", async () => {
    const events: ThinkingReplayEvent[] = [];
    const s = scripted([status(400), status(400, "Invalid tool schema."), textTurn]);
    const a = realAdapter(s.fetchImpl, events);
    const f1 = finishOf(await collect(a.stream(withReasoning(), S())));
    expect(f1.reason).toBe("error");
    expect(f1.error).toMatchObject({ kind: "invalid_request", beforeFirstOutput: true });
    expect(s.count()).toBe(2);
    expect(events).toEqual([]);
    await collect(a.stream(withReasoning(), S()));
    expect(types(s.bodies[2]!)).toContain("reasoning");
  });

  it("R3 a request without reasoning is not retried on 400 (1 fetch)", async () => {
    const events: ThinkingReplayEvent[] = [];
    const s = scripted([status(400)]);
    const f = finishOf(await collect(realAdapter(s.fetchImpl, events).stream(oReq(hist([op("rs_old", null), call])), S())));
    expect(f.reason).toBe("error");
    expect(s.count()).toBe(1);
    expect(events).toEqual([]);
  });

  it("R4 errors after first output are not retried (1 fetch, not disabled)", async () => {
    const events: ThinkingReplayEvent[] = [];
    const s = scripted([textThenError, textTurn]);
    const a = realAdapter(s.fetchImpl, events);
    const f = finishOf(await collect(a.stream(withReasoning(), S())));
    expect(f.reason).toBe("error");
    expect(s.count()).toBe(1);
    expect(events).toEqual([]);
    await collect(a.stream(withReasoning(), S()));
    expect(types(s.bodies[1]!)).toContain("reasoning");
  });

  it("R4b 400 after text was emitted (hand-written model) -> no retry, text once, not disabled", async () => {
    const parts: LanguageModelV4StreamPart[] = [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "lead" },
      { type: "error", error: new APICallError({ message: "bad reasoning", url: "https://api.openai.com/v1/responses", requestBodyValues: {}, statusCode: 400, isRetryable: false }) } as LanguageModelV4StreamPart];
    const lm = {
      specificationVersion: "v4" as const, provider: "openai.responses", modelId: M, supportedUrls: {}, n: 0,
      async doGenerate() { throw new Error("unused"); },
      async doStream() {
        lm.n++;
        const q = [...parts];
        return { stream: new ReadableStream<LanguageModelV4StreamPart>({ pull(c) { const x = q.shift(); if (x) c.enqueue(x); else c.close(); } }) };
      },
    };
    const events: ThinkingReplayEvent[] = [];
    const a = createModelAdapter({ budget: memBudget(1_000_000_000), ledger: createMemoryLedger(), prices: new PriceBook([table]), retrySameModel: 0,
      resolveModel: async () => ({ ok: true, model: lm as unknown as LanguageModelV4 }), onThinkingReplay: (e) => events.push(e) });
    const evs = await collect(a.stream(withReasoning(), S()));
    expect(lm.n).toBe(1);
    expect(evs.filter((e) => e.type === "text_delta")).toHaveLength(1);
    expect(finishOf(evs).error).toMatchObject({ kind: "invalid_request", httpStatus: 400, beforeFirstOutput: false });
    expect(events).toEqual([]);
  });

  it("R5 non-400 refusals (401, 404) are not retried", async () => {
    for (const [code, kind] of [[401, "auth"], [404, "invalid_request"]] as const) {
      const events: ThinkingReplayEvent[] = [];
      const s = scripted([status(code, "no")]);
      const f = finishOf(await collect(realAdapter(s.fetchImpl, events).stream(withReasoning(), S())));
      expect(f.error?.kind).toBe(kind);
      expect(s.count()).toBe(1);
      expect(events).toEqual([]);
    }
  });

  it("R6 replayThinking=false keeps openai reasoning; replayOpenaiReasoning=false drops it", () => {
    const r = withReasoning();
    expect(toV4(r, { replayThinking: false }).carriedOpenaiReasoning).toBe(1);
    const off = toV4(r, { replayOpenaiReasoning: false });
    expect([off.carriedOpenaiReasoning, off.droppedUnencrypted]).toEqual([0, 0]);
    const asst = off.options.prompt.find((m) => m.role === "assistant")!;
    expect((asst.content as Array<{ type: string }>).map((x) => x.type)).toEqual(["tool-call"]);
  });

  it("R7 encrypted content from another origin does not count for the group", () => {
    const other = { provider: "openai", model: "gpt-other" };
    const c = toV4(oReq(hist([op("rs_same", "enc-other", other), op("rs_same", null), call])));
    expect([c.droppedReasoning, c.droppedUnencrypted, c.carriedOpenaiReasoning]).toEqual([1, 1, 0]);
    const asst = c.options.prompt.find((m) => m.role === "assistant")!;
    expect((asst.content as Array<{ type: string }>).map((x) => x.type)).toEqual(["tool-call"]);
  });
});
