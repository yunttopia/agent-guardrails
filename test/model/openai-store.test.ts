import { describe, expect, it } from "vitest";
import { createModelAdapter } from "../../src/model/adapter.ts";
import type { FetchLike } from "../../src/model/guarded-fetch.ts";
import { createMemoryLedger } from "../../src/model/ledger.ts";
import { PriceBook, type PriceTable } from "../../src/model/prices.ts";
import { createModelResolver } from "../../src/model/resolve.ts";
import { OPENAI_STORE, toV4 } from "../../src/model/to-v4.ts";
import type { LoopMessage, ModelEvent, ModelRequest, Part } from "../../src/model/types.ts";
import { collect, memBudget, req, toolSpec } from "./helpers.ts";

const M = "gpt-6.1-sol";
const zeroish = (provider: string) => ({ provider, input: 1_000_000, output: 5_000_000, cache_read: 100_000, cache_write: 1_250_000, tiers: null });
const table: PriceTable = {
  schema: "agent-guardrails.prices/v0", version: "t", unit: "usd_micro_per_1m_tokens",
  fx: { mkrw_per_usd: 1_400_000, source: "test", checked: null },
  models: { [M]: zeroish("openai"), "claude-sonnet-5-5": zeroish("anthropic"), "gemini-test": zeroish("google") },
};

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((d, i) => `event: ${String(d["type"])}\ndata: ${JSON.stringify({ ...d, sequence_number: i })}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const resp = { id: "resp_test_1", created_at: 1794299456, model: M };
const completed = { type: "response.completed", response: { ...resp, status: "completed", incomplete_details: null, usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 59 } } };

const reasoningTurn = () => sse([
  { type: "response.created", response: resp },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_test_1", encrypted_content: null, summary: [] } },
  { type: "response.reasoning_summary_part.added", item_id: "rs_test_1", output_index: 0, summary_index: 0 },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_test_1", output_index: 0, summary_index: 0, delta: "find the note" },
  { type: "response.reasoning_summary_part.done", item_id: "rs_test_1", output_index: 0, summary_index: 0 },
  { type: "response.reasoning_summary_part.added", item_id: "rs_test_1", output_index: 0, summary_index: 1 },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_test_1", output_index: 0, summary_index: 1, delta: "start at A-17" },
  { type: "response.reasoning_summary_part.done", item_id: "rs_test_1", output_index: 0, summary_index: 1 },
  { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_test_1", encrypted_content: "enc-test-1", summary: [] } },
  { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_test_1", call_id: "call_test_1", name: "note_lookup", arguments: "", status: "in_progress" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_test_1", output_index: 1, delta: "{\"id\":\"A-17\"}" },
  { type: "response.function_call_arguments.done", item_id: "fc_test_1", output_index: 1, arguments: "{\"id\":\"A-17\"}" },
  { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_test_1", call_id: "call_test_1", name: "note_lookup", arguments: "{\"id\":\"A-17\"}", status: "completed" } },
  completed,
]);

function scripted(replies: Array<() => Response>) {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const fetchImpl: FetchLike = async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const r = replies[i++];
    if (!r) throw new Error(`fetch script exhausted (${i})`);
    return r();
  };
  return { fetchImpl, bodies };
}
function realAdapter(fetchImpl: FetchLike) {
  return createModelAdapter({
    budget: memBudget(1_000_000_000), ledger: createMemoryLedger(), prices: new PriceBook([table]),
    resolveModel: createModelResolver({ real: { enabled: true, secrets: { get: async (n) => (n === "OPENAI_API_KEY" ? "test-key-not-real-store" : n === "ANTHROPIC_API_KEY" ? "test-key-not-real-anthropic" : n === "GOOGLE_API_KEY" || n === "GEMINI_API_KEY" ? "g-test-0000" : null) }, fetchImpl } }),
  });
}
const S = () => new AbortController().signal;
function partsOf(evs: ModelEvent[]): Part[] {
  const out: Part[] = [];
  for (const e of evs) {
    if (e.type === "thinking_block") out.push(e.part);
    if (e.type === "tool_call") out.push({ kind: "tool_call", call: e.call, ...(e.opaque ? { opaque: e.opaque } : {}) });
  }
  return out;
}
const oReq = (messages: LoopMessage[] = [{ role: "user", content: "find note A-17" }]): ModelRequest =>
  req({ model: { provider: "openai", model: M, effort: "medium" }, tools: [toolSpec("note_lookup")], purpose: "main_turn", taskId: "app", attemptId: "app", messages });
const inputTypes = (b: Record<string, unknown>) => (b["input"] as Array<Record<string, unknown>>).map((x) => String(x["type"] ?? `role:${String(x["role"])}`));

describe("OpenAI store:false", () => {
  it("constant is false", () => expect(OPENAI_STORE).toBe(false));

  it("S1/S2 first request has store:false and include; received reasoning is replayed with encrypted content (no item_reference)", async () => {
    const s = scripted([reasoningTurn, reasoningTurn]);
    const adapter = realAdapter(s.fetchImpl);
    const r1 = oReq();
    const parts = partsOf(await collect(adapter.stream(r1, S())));
    const b1 = s.bodies[0]!;
    expect(b1["store"]).toBe(false);
    expect(b1["include"]).toEqual(["reasoning.encrypted_content"]);

    const th = parts.filter((p): p is Extract<Part, { kind: "thinking" }> => p.kind === "thinking");
    expect(th.map((p) => p.text)).toEqual(["find the note", "start at A-17"]);
    expect(th.map((p) => (p.opaque.providerMetadata["openai"] as Record<string, unknown>)["itemId"])).toEqual(["rs_test_1", "rs_test_1"]);
    expect(th.some((p) => (p.opaque.providerMetadata["openai"] as Record<string, unknown>)["reasoningEncryptedContent"] === "enc-test-1")).toBe(true);

    const r2 = oReq([...r1.messages, { role: "assistant", content: "", parts }, { role: "tool", callId: "call_test_1", content: "note A-17: meeting on Thursday", isError: false }]);
    expect(toV4(r2).droppedUnencrypted).toBe(0);
    await collect(adapter.stream(r2, S()));
    const b2 = s.bodies[1]!;
    expect(b2["store"]).toBe(false);
    expect(inputTypes(b2)).not.toContain("item_reference");
    expect(inputTypes(b2)).toEqual(["role:developer", "role:user", "reasoning", "function_call", "function_call_output"]);
    const reasoning = (b2["input"] as Array<Record<string, unknown>>).find((x) => x["type"] === "reasoning")!;
    expect(reasoning).toMatchObject({ id: "rs_test_1", encrypted_content: "enc-test-1", summary: [{ type: "summary_text", text: "find the note" }, { type: "summary_text", text: "start at A-17" }] });
  });

  const oldPart = (itemId: string, enc?: string | null): Part => ({ kind: "thinking", text: "old summary", opaque: { origin: { provider: "openai", model: M }, providerMetadata: { openai: { itemId, ...(enc !== undefined ? { reasoningEncryptedContent: enc } : {}) } }, redacted: false } });
  const call = (): Part => ({ kind: "tool_call", call: { id: "call_old_1", name: "note_lookup", args: { id: "A-17" } }, opaque: { origin: { provider: "openai", model: M }, providerMetadata: { openai: { itemId: "fc_old_1" } }, redacted: false } });
  const hist = (ps: Part[]): LoopMessage[] => [{ role: "user", content: "A-17" }, { role: "assistant", content: "", parts: ps }, { role: "tool", callId: "call_old_1", content: "note A-17", isError: false }];

  it("S3 legacy parts (itemId only or null) are dropped; no reasoning or item_reference in body", async () => {
    const r = oReq(hist([oldPart("rs_old_1"), oldPart("rs_old_2", null), call()]));
    const c = toV4(r);
    expect(c.droppedUnencrypted).toBe(2);
    expect(c.droppedReasoning).toBe(0);

    const asst = c.options.prompt.find((m) => m.role === "assistant")!;
    expect((asst.content as Array<{ type: string }>).map((x) => x.type)).toEqual(["tool-call"]);

    const s = scripted([reasoningTurn]);
    await collect(realAdapter(s.fetchImpl).stream(r, S()));
    expect(inputTypes(s.bodies[0]!)).toEqual(["role:developer", "role:user", "function_call", "function_call_output"]);
  });

  it("S4 an itemId group is sent if any part has encrypted content; empty string counts as none", () => {
    const c = toV4(oReq(hist([oldPart("rs_a"), oldPart("rs_a", "enc-a"), oldPart("rs_b", ""), call()])));
    expect(c.droppedUnencrypted).toBe(1);
    const asst = c.options.prompt.find((m) => m.role === "assistant")!;
    expect((asst.content as Array<{ type: string }>).map((x) => x.type)).toEqual(["reasoning", "reasoning", "tool-call"]);
  });

  it("S5 other providers get no openai store option", () => {
    for (const provider of ["anthropic", "google", "fake"]) {
      const c = toV4(req({ model: { provider, model: provider === "anthropic" ? "claude-sonnet-5-5" : "m", effort: null } }));
      expect((c.options.providerOptions as Record<string, unknown> | undefined)?.["openai"]).toBeUndefined();
    }
    expect(toV4(oReq()).options.providerOptions).toEqual({ openai: { store: false } });
  });
});
