import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelAdapter } from "../../src/model/adapter.ts";
import { DEFAULT_USER_AGENT, type ExchangeRecord, type FetchLike } from "../../src/model/guarded-fetch.ts";
import { createMemoryLedger } from "../../src/model/ledger.ts";
import { PriceBook, type PriceTable } from "../../src/model/prices.ts";
import { createRealLanguageModel, PROVIDER_BINDINGS, type SecretSource } from "../../src/model/providers.ts";
import { createModelResolver } from "../../src/model/resolve.ts";
import { collect, memBudget, req } from "./helpers.ts";

const KEY = "test-key-not-real-7f3a";
// Built at runtime so secret scanners do not flag a key-shaped literal; the adapter must still mask it.
const SK_PREFIX = ["s", "k", "-"].join("");

function secrets(map: Record<string, string>): SecretSource & { asked: string[] } {
  const asked: string[] = [];
  return { asked, get: async (n) => (asked.push(n), map[n] ?? null) };
}

function sse(events: Array<[string, unknown]>): Response {
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const anthropicReply = () =>
  sse([
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello there" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }],
    ["message_stop", { type: "message_stop" }],
  ]);

const table: PriceTable = {
  schema: "agent-guardrails.prices/v0", version: "t", unit: "usd_micro_per_1m_tokens",
  fx: { mkrw_per_usd: 1_400_000, source: "test", checked: null },
  models: { "claude-haiku-5-5": { provider: "anthropic", input: 1_000_000, output: 5_000_000, cache_read: 100_000, cache_write: 1_250_000, tiers: null } },
};

afterEach(() => vi.unstubAllEnvs());

describe("real provider path (no network)", () => {
  it("pinned versions match package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    for (const b of Object.values(PROVIDER_BINDINGS)) {
      const [name, ver] = [b.pkg.slice(0, b.pkg.lastIndexOf("@")), b.pkg.slice(b.pkg.lastIndexOf("@") + 1)];
      expect(pkg.dependencies[name]).toBe(ver);
    }
    expect(Object.values(PROVIDER_BINDINGS).map((b) => b.secretName)).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]);
  });

  it("off by default: does not even ask for secrets", async () => {
    const s = secrets({ ANTHROPIC_API_KEY: KEY });
    expect(await createRealLanguageModel("anthropic", "claude-haiku-5-5", { enabled: false, secrets: s })).toEqual({ ok: false, code: "real_calls_disabled" });
    expect(s.asked).toEqual([]);
  });

  it("ignores keys and base URLs from environment variables", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example.net");
    expect(await createRealLanguageModel("anthropic", "claude-haiku-5-5", { enabled: true, secrets: secrets({}) })).toEqual({ ok: false, code: "secret_missing" });
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (u) => (seen.push(String(u)), anthropicReply());
    const r = await createRealLanguageModel("anthropic", "claude-haiku-5-5", { enabled: true, secrets: secrets({ ANTHROPIC_API_KEY: KEY }), fetchImpl });
    if (!r.ok) throw new Error(r.code);
    await r.model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(new URL(seen[0] ?? "").host).toBe("api.anthropic.com");
  });

  it("anthropic: fixed UA and key header; response becomes events, cost and ledger row; key never stored", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    const sent: Array<{ url: string; headers: Headers }> = [];
    const exchanges: ExchangeRecord[] = [];
    const fetchImpl: FetchLike = async (u, init) => (sent.push({ url: String(u), headers: new Headers(init?.headers) }), anthropicReply());
    const ledger = createMemoryLedger();
    const adapter = createModelAdapter({
      budget: memBudget(10_000_000), ledger, prices: new PriceBook([table]),
      resolveModel: createModelResolver({ real: { enabled: true, secrets: secrets({ ANTHROPIC_API_KEY: KEY }), fetchImpl, onExchange: (e) => exchanges.push(e) } }),
    });
    const evs = await collect(adapter.stream(req({ model: { provider: "anthropic", model: "claude-haiku-5-5", effort: null } }), new AbortController().signal));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]?.headers.get("user-agent")).toBe(DEFAULT_USER_AGENT);
    expect(sent[0]?.headers.get("x-api-key")).toBe(KEY);
    expect([...(sent[0]?.headers.keys() ?? [])].sort()).toEqual(["anthropic-version", "content-type", "user-agent", "x-api-key"]);
    const f = evs.at(-1);
    expect(f).toMatchObject({ type: "finish", reason: "stop", usage: { inputTokens: 50, outputTokens: 7, cacheReadTokens: 20 } });
    // 50×$1/M + 7×$5/M + 20×$0.1/M = 50+35+2 = 87 µ$ → ×1400 = 121.8 mkrw → 122
    expect(f).toMatchObject({ cost: { cost_mkrw: 122, estimated: false } });
    expect(ledger.rows[0]).toMatchObject({ funding: "anthropic-credit", usdActualMicro: 87, krwRate: "1400(test)", krwActualMkrw: 122 });
    expect(exchanges).toEqual([{ name: "anthropic", host: "api.anthropic.com", method: "POST", status: 200, reqBytes: expect.any(Number), resBytes: null }]);
    expect(JSON.stringify([evs, ledger.rows, exchanges])).not.toContain(KEY);
  });

  it("401: auth error without the key", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } });
    const ledger = createMemoryLedger();
    const adapter = createModelAdapter({ budget: memBudget(10_000_000), ledger, prices: new PriceBook([table]), resolveModel: createModelResolver({ real: { enabled: true, secrets: secrets({ ANTHROPIC_API_KEY: KEY }), fetchImpl } }) });
    const evs = await collect(adapter.stream(req({ model: { provider: "anthropic", model: "claude-haiku-5-5", effort: null } }), new AbortController().signal));
    expect(evs.at(-1)).toMatchObject({ reason: "error", error: { kind: "auth", httpStatus: 401, retriedTimes: 0 } });
    expect(JSON.stringify([evs, ledger.rows])).not.toContain(KEY);
  });

  it("400: only error.type and message (300 chars, sk- masked, no key or request body) are recorded", async () => {
    const SECRET_PROMPT = "request-body-marker-9q2";
    const longTail = "x".repeat(400);
    const msg = `output_config.effort: Extra inputs are not permitted\n\t(key ${SK_PREFIX}test-api03-ABCdef_123-xyz) ${longTail}`;
    const body = { type: "error", error: { type: "invalid_request_error", message: msg }, request_id: "req_should_not_appear" };
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } });
    const ledger = createMemoryLedger();
    const adapter = createModelAdapter({ budget: memBudget(10_000_000), ledger, prices: new PriceBook([table]), resolveModel: createModelResolver({ real: { enabled: true, secrets: secrets({ ANTHROPIC_API_KEY: KEY }), fetchImpl } }) });
    const evs = await collect(adapter.stream(req({ model: { provider: "anthropic", model: "claude-haiku-5-5", effort: "medium" }, system: SECRET_PROMPT, messages: [{ role: "user", content: SECRET_PROMPT }] }), new AbortController().signal));
    const f = evs.at(-1);
    expect(f).toMatchObject({ reason: "error", error: { kind: "invalid_request", httpStatus: 400, retriedTimes: 0 } });
    if (f?.type !== "finish" || !f.record) throw new Error("no record");
    expect(f.record.provider_error_type).toBe("invalid_request_error");
    const m = f.record.provider_error_message ?? "";
    expect(m.startsWith("output_config.effort: Extra inputs are not permitted (key sk-***) xx")).toBe(true);
    expect([...m].length).toBe(301);
    expect(m).not.toMatch(/[\t\r\n]/);
    const basis = ledger.rows[0]?.basis ?? "";
    expect(basis).toContain(" error:invalid_request provider_error:invalid_request_error \"output_config.effort: Extra inputs are not permitted");
    const all = JSON.stringify([evs, ledger.rows]);
    for (const leak of [KEY, `${SK_PREFIX}test-api03`, SECRET_PROMPT, "req_should_not_appear"]) expect(all).not.toContain(leak);
  });

  it("non-JSON error bodies are dropped; successful calls have no provider_error fields", async () => {
    const ledger = createMemoryLedger();
    const html = new Response("<html>bad gateway test-key-not-real-zzz</html>", { status: 400 });
    const adapter = createModelAdapter({ budget: memBudget(10_000_000), ledger, prices: new PriceBook([table]), resolveModel: createModelResolver({ real: { enabled: true, secrets: secrets({ ANTHROPIC_API_KEY: KEY }), fetchImpl: async () => html } }) });
    const evs = await collect(adapter.stream(req({ model: { provider: "anthropic", model: "claude-haiku-5-5", effort: null } }), new AbortController().signal));
    const f = evs.at(-1);
    if (f?.type !== "finish" || !f.record) throw new Error("no record");
    expect("provider_error_type" in f.record).toBe(false);
    expect(ledger.rows[0]?.basis).not.toContain("provider_error");
    expect(JSON.stringify([evs, ledger.rows])).not.toContain("bad gateway");

    const ok = createModelAdapter({ budget: memBudget(10_000_000), ledger: createMemoryLedger(), prices: new PriceBook([table]), resolveModel: createModelResolver({ real: { enabled: true, secrets: secrets({ ANTHROPIC_API_KEY: KEY }), fetchImpl: async () => anthropicReply() } }) });
    const g = (await collect(ok.stream(req({ model: { provider: "anthropic", model: "claude-haiku-5-5", effort: null } }), new AbortController().signal))).at(-1);
    if (g?.type !== "finish" || !g.record) throw new Error("no record");
    expect("provider_error_type" in g.record).toBe(false);
  });

  it("stream error chunks keep only type and message", async () => {
    const ledger = createMemoryLedger();
    const fetchImpl: FetchLike = async () => sse([
      ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
      ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
    ]);
    const adapter = createModelAdapter({ budget: memBudget(10_000_000), ledger, prices: new PriceBook([table]), retrySameModel: 0, resolveModel: createModelResolver({ real: { enabled: true, secrets: secrets({ ANTHROPIC_API_KEY: KEY }), fetchImpl } }) });
    const f = (await collect(adapter.stream(req({ model: { provider: "anthropic", model: "claude-haiku-5-5", effort: null } }), new AbortController().signal))).at(-1);
    if (f?.type !== "finish" || !f.record) throw new Error("no record");
    expect({ t: f.record.provider_error_type, m: f.record.provider_error_message }).toEqual({ t: "overloaded_error", m: "Overloaded" });
    expect(ledger.rows[0]?.basis).toContain("provider_error:overloaded_error \"Overloaded\"");
  });

  it("openai and google use only their fixed hosts and auth headers", async () => {
    for (const [p, host, authHeader] of [["openai", "api.openai.com", "authorization"], ["google", "generativelanguage.googleapis.com", "x-goog-api-key"]] as const) {
      const sent: Array<{ url: string; headers: Headers }> = [];
      const fetchImpl: FetchLike = async (u, init) => (sent.push({ url: String(u), headers: new Headers(init?.headers) }), new Response("{}", { status: 500 }));
      const r = await createRealLanguageModel(p, "m", { enabled: true, secrets: secrets({ [PROVIDER_BINDINGS[p].secretName]: KEY }), fetchImpl });
      if (!r.ok) throw new Error(r.code);
      await expect(r.model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).rejects.toThrow();
      expect(new URL(sent[0]?.url ?? "").host).toBe(host);
      expect(sent[0]?.headers.get("user-agent")).toBe(DEFAULT_USER_AGENT);
      expect(sent[0]?.headers.get(authHeader)).toContain(KEY);
      expect([...(sent[0]?.headers.keys() ?? [])].filter((k) => !PROVIDER_BINDINGS[p].allowedHeaderNames.includes(k) && k !== "user-agent")).toEqual([]);
    }
  });
});
