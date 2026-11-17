import { describe, expect, it } from "vitest";
import { createModelAdapter, type ModelAdapterDeps } from "../../src/model/adapter.ts";
import { createFakeLanguageModel, type FakeTurn } from "../../src/model/fake.ts";
import { createMemoryLedger } from "../../src/model/ledger.ts";
import { FAKE_PRICE_TABLE, PriceBook } from "../../src/model/prices.ts";
import { createModelResolver } from "../../src/model/resolve.ts";
import { toV4 } from "../../src/model/to-v4.ts";
import type { ModelEvent } from "../../src/model/types.ts";
import { collect, memBudget, req, toolSpec } from "./helpers.ts";

function setup(script: FakeTurn[], over: Partial<ModelAdapterDeps> = {}) {
  const fake = createFakeLanguageModel(script);
  const budget = memBudget(1_000_000);
  const ledger = createMemoryLedger();
  const sleeps: number[] = [];
  const adapter = createModelAdapter({
    budget, ledger,
    prices: new PriceBook([FAKE_PRICE_TABLE]),
    resolveModel: createModelResolver({ fakes: { "fake-1": fake } }),
    sleep: async (ms) => void sleeps.push(ms),
    now: () => new Date("2026-10-31T10:00:00+09:00"),
    ...over,
  });
  return { fake, budget, ledger, sleeps, adapter };
}

const finishOf = (evs: ModelEvent[]) => {
  const f = evs.at(-1);
  if (!f || f.type !== "finish") throw new Error("no finish");
  return f;
};

describe("adapter with fake provider", () => {
  it("text and tool call become events, one zero-cost ledger row and a model_call record", async () => {
    const { adapter, ledger, budget } = setup([
      { kind: "reply", parts: [{ text: "searching " }, { text: "docs" }, { toolCall: { name: "docs.search", args: { q: "from:me" } } }], usage: { input: 120, output: 30, cacheRead: 80 } },
    ]);
    const evs = await collect(adapter.stream(req({ tools: [toolSpec("docs.search")] }), new AbortController().signal));
    expect(evs.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("searching docs");
    expect(evs.find((e) => e.type === "tool_call")).toMatchObject({ call: { id: "fake_call_2", name: "docs.search", args: { q: "from:me" } } });
    const f = finishOf(evs);
    expect(f.reason).toBe("tool_calls");
    expect(f.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 0, reasoningTokens: 0 });
    expect(f.record).toEqual({
      type: "model_call", provider: "fake", model: "fake-1", purpose: "worker_turn", input_tokens: 120, output_tokens: 30, cache_read_tokens: 80,
      cost_mkrw: 0, price_ref: "prices/fake.json#fake/fake-1", usage_estimated: false, mode: "balanced", effort: null,
    });
    expect(f.cache.hitRatio).toBeCloseTo(80 / 200);
    expect(ledger.rows).toEqual([expect.objectContaining({ runId: "t1/a1", provider: "fake", calls: 1, inputTokens: 120, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: null, usdActualMicro: 0, krwActualMkrw: 0, funding: "none" })]);
    expect(budget.reserves[0]?.keys).toEqual([{ scope: "task", id: "t1" }, { scope: "day", id: "2026-10-31" }, { scope: "month", id: "2026-10" }]);
    expect(budget.settles).toEqual([{ id: "r1", actualMkrw: 0 }]);
  });

  it("reported cache-write tokens go to the cache_write_tokens column", async () => {
    const { adapter, ledger } = setup([{ kind: "reply", parts: [{ text: "ok" }], usage: { input: 4, output: 9, cacheRead: 0, cacheWrite: 2436 } }]);
    const f = finishOf(await collect(adapter.stream(req({ taskId: "app", attemptId: "app", purpose: "main_turn" }), new AbortController().signal)));
    expect(f.usage.cacheWriteTokens).toBe(2436);
    expect(f.record).toMatchObject({ cache_write_tokens: 2436 });
    expect(ledger.rows[0]).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 2436 });
  });

  it("a call without a task (app) reserves day and month keys", async () => {
    const { adapter, budget, ledger } = setup([{ kind: "reply", parts: [{ text: "ok" }] }]);
    await collect(adapter.stream(req({ taskId: "app", attemptId: "app", purpose: "main_turn" }), new AbortController().signal));
    expect(budget.reserves[0]?.keys).toEqual([{ scope: "day", id: "2026-10-31" }, { scope: "month", id: "2026-10" }]);
    expect(ledger.rows[0]?.runId).toBe("app/app");
  });

  it("no monthly cap set -> zero calls, no record, no ledger row", async () => {
    const { adapter, fake, ledger } = setup([{ kind: "reply", parts: [{ text: "x" }] }], { budget: memBudget(null) });
    const f = finishOf(await collect(adapter.stream(req(), new AbortController().signal)));
    expect(f).toMatchObject({ reason: "error", error: { kind: "budget", providerCode: "cap_not_set", beforeFirstOutput: true } });
    expect(f.record).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("429 honours retry-after and retries the same model; success gives calls 2", async () => {
    const { adapter, fake, sleeps, ledger } = setup([{ kind: "http_error", status: 429, retryAfterSec: 3 }, { kind: "reply", parts: [{ text: "ok" }] }]);
    const evs = await collect(adapter.stream(req(), new AbortController().signal));
    const f = finishOf(evs);
    expect(f.reason).toBe("stop");

    expect(evs.filter((e) => e.type === "retry")).toEqual([{ type: "retry", reason: "rate_limit", attempt: 1, maxAttempts: 2, delayMs: 3000 }]);
    expect(evs.findIndex((e) => e.type === "retry")).toBeLessThan(evs.findIndex((e) => e.type === "text_delta"));
    expect(fake.calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
    expect(ledger.rows[0]?.calls).toBe(2);
  });

  it("retries exhausted (529 three times) -> beforeFirstOutput true, retriedTimes 2", async () => {
    const { adapter, sleeps } = setup([{ kind: "http_error", status: 529 }, { kind: "http_error", status: 529 }, { kind: "http_error", status: 529 }]);
    const evs = await collect(adapter.stream(req(), new AbortController().signal));
    const f = finishOf(evs);
    expect(f.error).toEqual({ kind: "overloaded", httpStatus: 529, retriedTimes: 2, beforeFirstOutput: true });
    expect(sleeps).toEqual([1000, 2000]);

    expect(evs.filter((e) => e.type === "retry").map((e) => e.type === "retry" && [e.reason, e.attempt, e.delayMs])).toEqual([["overloaded", 1, 1000], ["overloaded", 2, 2000]]);
  });

  it("401 is not retried", async () => {
    const { adapter, fake } = setup([{ kind: "http_error", status: 401 }, { kind: "reply", parts: [] }]);
    const evs401 = await collect(adapter.stream(req(), new AbortController().signal));
    expect(evs401.some((e) => e.type === "retry")).toBe(false);
    const f = finishOf(evs401);
    expect(f.error).toMatchObject({ kind: "auth", retriedTimes: 0 });
    expect(fake.calls).toHaveLength(1);
  });

  it("a break after first output is not retried; beforeFirstOutput false, estimated usage", async () => {
    const { adapter, fake } = setup([{ kind: "reply", parts: [{ text: "abc" }, { text: "def" }], failAfterParts: 1 }, { kind: "reply", parts: [] }]);
    const f = finishOf(await collect(adapter.stream(req(), new AbortController().signal)));
    expect(f.error).toMatchObject({ kind: "overloaded", beforeFirstOutput: false, retriedTimes: 0 });
    expect(f.record?.usage_estimated).toBe(true);
    expect(f.usage.outputTokens).toBe(3);
    expect(fake.calls).toHaveLength(1);
  });

  it("content-filter -> refusal; missing usage -> usage_estimated", async () => {
    const { adapter } = setup([{ kind: "reply", parts: [{ text: "cannot do that" }], finish: "content-filter", usage: null }]);
    const f = finishOf(await collect(adapter.stream(req(), new AbortController().signal)));
    expect(f.reason).toBe("refusal");
    expect(f.record).toMatchObject({ usage_estimated: true });
    expect(f.record).not.toHaveProperty("cache_read_tokens");
    expect(f.cache.defect).toBeNull();
  });

  it("non-JSON tool args give tool_args_unparsable and no tool_call", async () => {
    const { adapter } = setup([{ kind: "reply", parts: [{ rawToolCall: { name: "x", input: "{bad" } }] }]);
    const evs = await collect(adapter.stream(req({ tools: [toolSpec("x")] }), new AbortController().signal));
    expect(evs.some((e) => e.type === "tool_call")).toBe(false);
    expect(finishOf(evs).error).toMatchObject({ kind: "tool_args_unparsable", beforeFirstOutput: false });
  });

  it("reasoning blocks: replayed for the same model, dropped and reported for another", async () => {
    const dropped: number[] = [];
    const { adapter, fake } = setup([{ kind: "reply", parts: [{ reasoning: "thinking", signature: "S1" }, { text: "answer" }] }, { kind: "reply", parts: [{ text: "next" }] }], { onReasoningDropped: (n) => dropped.push(n) });
    const evs = await collect(adapter.stream(req(), new AbortController().signal));
    const block = evs.find((e) => e.type === "thinking_block");
    expect(block).toMatchObject({ part: { text: "thinking", opaque: { origin: { provider: "fake", model: "fake-1" }, providerMetadata: { fake: { signature: "S1" } } } } });
    if (block?.type !== "thinking_block") throw new Error();
    const other = { ...block.part, opaque: { ...block.part.opaque, origin: { provider: "openai", model: "x" } } };
    await collect(adapter.stream(req({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "answer", parts: [block.part, other, { kind: "text", text: "answer" }] }, { role: "user", content: "b" }] }), new AbortController().signal));
    const sent = fake.calls[1]?.prompt.find((m) => m.role === "assistant");
    expect(sent?.content).toEqual([{ type: "reasoning", text: "thinking", providerOptions: { fake: { signature: "S1" } } }, { type: "text", text: "answer" }]);
    expect(dropped).toEqual([1]);
  });

  it("changed tool definitions give tools_changed; unchanged with zero cache gives miss_unchanged_prefix", async () => {
    const tool = (name: string) => ({ name, description: name.toUpperCase(), argsSchema: { type: "object" }, effect: "read" as const, risk: "none" as const, network: false });
    const tools = [tool("b"), tool("a")];
    const { adapter, fake } = setup([
      { kind: "reply", parts: [{ text: "1" }], usage: { input: 10, output: 1, cacheRead: 0 } },
      { kind: "reply", parts: [{ text: "2" }], usage: { input: 10, output: 1, cacheRead: 0 } },
      { kind: "reply", parts: [{ text: "3" }], usage: { input: 10, output: 1, cacheRead: 5 } },
    ]);
    const s = new AbortController().signal;
    expect(finishOf(await collect(adapter.stream(req({ tools }), s))).cache.defect).toBeNull();
    expect(finishOf(await collect(adapter.stream(req({ tools }), s))).cache.defect).toEqual({ kind: "miss_unchanged_prefix" });
    expect(finishOf(await collect(adapter.stream(req({ tools: tools.slice(1) }), s))).cache.defect).toEqual({ kind: "tools_changed" });
    expect(fake.calls[0]?.tools?.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("effort maps to reasoning; provider-default and null are not sent", () => {
    expect(toV4(req({ model: { provider: "fake", model: "fake-1", effort: "low" } })).options.reasoning).toBe("low");
    expect(toV4(req({ model: { provider: "fake", model: "fake-1", effort: "provider-default" } })).options).not.toHaveProperty("reasoning");
  });

  it("anthropic gets cache breakpoints on system and last user message", () => {
    const { options } = toV4(req({ model: { provider: "anthropic", model: "claude-haiku-5-5", effort: null }, messages: [{ role: "user", content: "1" }, { role: "assistant", content: "2" }, { role: "user", content: "3" }] }));
    const marks = options.prompt.map((m) => (m.providerOptions ? m.role : null));
    expect(marks).toEqual(["system", null, null, "user"]);
  });

  it("tool results take the tool name from the preceding assistant call", () => {
    const { options } = toV4(req({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "docs.read", args: { id: 1 } }] }, { role: "tool", callId: "c1", content: "BODY", isError: false }] }));
    expect(options.prompt.at(-1)).toEqual({ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "docs.read", output: { type: "text", value: "BODY" } }] });
  });

  it("abort signal -> aborted, no retry", async () => {
    const { adapter, fake } = setup([{ kind: "reply", parts: [{ text: "a" }, { text: "b" }] }, { kind: "reply", parts: [] }]);
    const ac = new AbortController();
    const evs: ModelEvent[] = [];
    for await (const e of adapter.stream(req(), ac.signal)) {
      evs.push(e);
      if (e.type === "text_delta") ac.abort();
    }
    expect(finishOf(evs).error).toMatchObject({ kind: "aborted", beforeFirstOutput: false });
    expect(fake.calls).toHaveLength(1);
  });

  it("real providers are off by default: reservation released, no call", async () => {
    const budget = memBudget(1_000_000);
    const ledger = createMemoryLedger();
    const priced = new PriceBook([{ ...FAKE_PRICE_TABLE, version: "t", models: { "claude-haiku-5-5": { provider: "anthropic", input: 1, output: 1, cache_read: 1, cache_write: 1, tiers: null } } }]);
    const adapter = createModelAdapter({ budget, ledger, prices: priced, resolveModel: createModelResolver({}) });
    const f = finishOf(await collect(adapter.stream(req({ model: { provider: "anthropic", model: "claude-haiku-5-5", effort: null } }), new AbortController().signal)));
    expect(f.error).toMatchObject({ kind: "invalid_request", providerCode: "real_calls_disabled" });
    expect(budget.releases).toEqual(["r1"]);
    expect(ledger.rows).toHaveLength(0);
  });

  it("unknown-price model: no reservation and no call", async () => {
    const { adapter, budget } = setup([]);
    const f = finishOf(await collect(adapter.stream(req({ model: { provider: "anthropic", model: "claude-opus-5-5", effort: null } }), new AbortController().signal)));
    expect(f.error).toMatchObject({ kind: "invalid_request", providerCode: "price_unknown" });
    expect(budget.reserves).toHaveLength(0);
  });
});

describe("fx rate changes", () => {
  it("a prices function is read per call (reserve at start, settle at end)", async () => {
    const table = { ...FAKE_PRICE_TABLE, version: "t", models: { "fake-1": { provider: "fake", input: 1_000_000, output: 1_000_000, cache_read: 0, cache_write: 0, tiers: null } } };
    let book = new PriceBook([table], { fx: { mkrw_per_usd: 1_000_000, source: "a" } });
    const fake = createFakeLanguageModel([{ kind: "reply", parts: [{ text: "x" }], usage: { input: 1000, output: 0 } }, { kind: "reply", parts: [{ text: "y" }], usage: { input: 1000, output: 0 } }]);
    const ledger = createMemoryLedger();
    const adapter = createModelAdapter({ budget: memBudget(1e12), ledger, prices: () => book, resolveModel: createModelResolver({ fakes: { "fake-1": fake } }) });
    await collect(adapter.stream(req(), new AbortController().signal));
    book = new PriceBook([table], { fx: { mkrw_per_usd: 2_000_000, source: "b" } });
    await collect(adapter.stream(req(), new AbortController().signal));

    expect(ledger.rows.map((r) => r.krwActualMkrw)).toEqual([1000, 2000]);
  });
});
