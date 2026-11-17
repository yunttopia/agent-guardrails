import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSUMED_CONTEXT_CHARS, parsePriceTable, PriceBook, type PriceTable } from "../../src/model/prices.ts";

const dataDir = new URL("../../data/prices/", import.meta.url);
const raw = (f: string) => JSON.parse(readFileSync(new URL(f, dataDir), "utf8")) as Record<string, unknown>;
const base = (models: PriceTable["models"]): PriceTable => ({
  schema: "agent-guardrails.prices/v0", version: "t", unit: "usd_micro_per_1m_tokens", fx: { mkrw_per_usd: 1_450_000, source: "test", checked: null }, models,
});
const m = (extra: Record<string, unknown> = {}) => ({ provider: "p", input: 1, output: 1, cache_read: null, cache_write: null, tiers: null, ...extra });

describe("parsePriceTable context_tokens", () => {
  it("accepts missing/null; only positive integers are values", () => {
    expect(parsePriceTable(base({ a: m() })).models["a"]!.context_tokens).toBeUndefined();
    expect(parsePriceTable(base({ a: m({ context_tokens: null }) })).models["a"]!.context_tokens).toBeNull();
    expect(parsePriceTable(base({ a: m({ context_tokens: 1_000_000 }) })).models["a"]!.context_tokens).toBe(1_000_000);
  });
  it.each([0, -1, 1.5, "1000000", Number.MAX_SAFE_INTEGER + 1])("%s fails to parse", (v) => {
    expect(() => parsePriceTable(base({ a: m({ context_tokens: v }) }))).toThrow(/context_tokens/u);
  });
});

describe("PriceBook.contextWindowOf", () => {
  const t1 = base({ a: m({ context_tokens: 500 }), b: m() });
  it("value when listed; null for other provider, unlisted model or missing field", () => {
    const book = new PriceBook([t1]);
    expect(book.contextWindowOf("p", "a")).toBe(500);
    expect(book.contextWindowOf("q", "a")).toBeNull();
    expect(book.contextWindowOf("p", "zz")).toBeNull();
    expect(book.contextWindowOf("p", "b")).toBeNull();
  });
  it("with two tables the first wins; window survives price expiry", () => {
    const newer = base({ a: m({ context_tokens: 900, valid_until: "2000-01-01" }) });
    expect(new PriceBook([newer, t1]).contextWindowOf("p", "a")).toBe(900);
    expect(new PriceBook([t1, newer]).contextWindowOf("p", "a")).toBe(500);
  });
  it("old table (2026-10-31) alone gives null for every model", () => {
    const old = parsePriceTable(raw("2026-10-31.json"));
    const book = new PriceBook([old]);
    for (const [id, p] of Object.entries(old.models)) expect(book.contextWindowOf(p.provider, id)).toBeNull();
  });
  it("assumed default context is 200k chars", () => {
    expect(ASSUMED_CONTEXT_CHARS).toBe(200_000);
  });
});

describe("price table 2026-11-03.json", () => {
  const NEW = raw("2026-11-03.json");
  const OLD = raw("2026-10-31.json");
  const t = parsePriceTable(NEW);
  const CONTEXT_KEYS = ["context_tokens", "context_source", "context_checked", "context_note"];
  it("all 8 models have context fields sourced from provider docs only", () => {
    expect(Object.keys(t.models)).toHaveLength(8);
    const hosts = new Set(["docs.claude.com", "platform.openai.com", "ai.google.dev"]);
    for (const [id, p] of Object.entries(t.models)) {
      expect(p.context_tokens, id).toBeGreaterThan(0);
      expect(p.context_checked, id).toBe("2026-11-03");
      expect(hosts.has(new URL(p.context_source!).hostname), id).toBe(true);
      expect(p.context_source!, id).not.toMatch(/openrouter/iu);
    }
    expect(JSON.stringify(NEW)).not.toMatch(/openrouter/iu);
  });
  it("context window values", () => {
    const book = new PriceBook([t]);

    const want: Array<[string, string, number]> = [
      ["anthropic", "claude-opus-5-5", 1_000_000], ["anthropic", "claude-sonnet-5-5", 1_000_000], ["anthropic", "claude-haiku-5-5", 1_000_000],
      ["openai", "gpt-6-astra", 1_050_000], ["openai", "gpt-6.1-sol", 1_050_000], ["openai", "gpt-6.1-terra", 1_050_000], ["openai", "gpt-6-luna", 1_050_000],
      ["google", "gemini-3.8-flash", 1_048_576],
    ];
    for (const [p, id, v] of want) expect(book.contextWindowOf(p, id), id).toBe(v);
    expect(want).toHaveLength(Object.keys(t.models).length);
  });
  it("prices and fx equal the 10-31 table except version and context fields", () => {
    const strip = (o: Record<string, unknown>) => {
      const c = structuredClone(o);
      delete c["version"];
      for (const p of Object.values(c["models"] as Record<string, Record<string, unknown>>)) for (const k of CONTEXT_KEYS) delete p[k];
      return c;
    };
    expect(strip(NEW)).toEqual(strip(OLD));
    expect(NEW["version"]).toBe("2026-11-03");
    expect(OLD["version"]).toBe("2026-10-31");
  });
});
