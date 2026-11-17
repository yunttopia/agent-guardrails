import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_FX, FAKE_PRICE_TABLE, formatKrwApprox, parsePriceTable, PriceBook, type PriceTable } from "../../src/model/prices.ts";
import { capEffort, parseRoutingFile, pick, pickOffline, PURPOSE_ROUTING_KIND } from "../../src/model/routing.ts";

const dataDir = new URL("../../data/", import.meta.url);
const routing = parseRoutingFile(JSON.parse(readFileSync(new URL("routing.json", dataDir), "utf8")));
const realPrices = parsePriceTable(JSON.parse(readFileSync(new URL("prices/2026-10-30.json", dataDir), "utf8")));

const table: PriceTable = {
  schema: "agent-guardrails.prices/v0", version: "2026-10-31", unit: "usd_micro_per_1m_tokens",
  fx: { mkrw_per_usd: 1_400_000, source: "test", checked: "2026-10-31" },
  models: {
    m: { provider: "p", input: 3_000_000, output: 15_000_000, cache_read: 300_000, cache_write: null, tiers: [{ inputTokensAbove: 200_000, input: 6_000_000, output: 22_500_000, cache_read: 600_000, cache_write: null }] },
  },
};

describe("prices", () => {
  const book = new PriceBook([table, FAKE_PRICE_TABLE]);
  it("integer math and price_ref", () => {
    expect(book.cost("p", "m", { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 })).toEqual({ cost_mkrw: 14700, usd_micro: 10500, price_ref: "prices/2026-10-31.json#p/m", estimated: false, fx: { mkrw_per_usd: 1_400_000, source: "test" } });
  });
  it("rounds 0.5 up", () => {
    expect(book.cost("p", "m", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })?.cost_mkrw).toBe(25);
    const half: PriceTable = { ...table, version: "h", fx: { ...table.fx, mkrw_per_usd: 500 }, models: { h: { provider: "p", input: 1_000_000, output: 0, cache_read: 0, cache_write: 0, tiers: null } } };

    expect(new PriceBook([half]).cost("p", "h", { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 })?.cost_mkrw).toBe(1);
  });
  it("missing cache_write uses input x 5/4 (conservative) and estimated", () => {
    const c = book.cost("p", "m", { input: 0, output: 0, cacheRead: 0, cacheWrite: 100_000 });
    expect(c).toMatchObject({ usd_micro: 375_000, estimated: true });
  });
  it("long-context tier pricing", () => {
    expect(book.cost("p", "m", { input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0 })?.usd_micro).toBe(1_800_000);
  });
  it("worst case uses cache-write price when higher", () => {
    expect(book.worstCase("p", "m", 1_000_000, 0)?.usd_micro).toBe(7_500_000);
  });
  it("table without fx cannot price", () => {
    const real = new PriceBook([realPrices]);
    expect(real.isKnown("anthropic", "claude-opus-5-5")).toBe(false);
    expect(real.cost("anthropic", "claude-opus-5-5", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
  it("fake model costs zero", () => {
    expect(book.cost("fake", "fake-1", { input: 123, output: 456, cacheRead: 7, cacheWrite: 8 })).toMatchObject({ cost_mkrw: 0, usd_micro: 0, price_ref: "prices/fake.json#fake/fake-1", estimated: false });
  });
  it("rejects non-integer prices", () => {
    expect(() => parsePriceTable({ ...table, models: { x: { ...table.models.m, input: 1.5 } } })).toThrow(/integer/);
  });
});

describe("routing", () => {
  const known = () => true;
  it("effort cap takes the lower value and never raises", () => {
    const order = routing.modes.effortOrder;
    expect(capEffort("xhigh", "medium", order, "medium")).toBe("medium");
    expect(capEffort("none", "medium", order, "medium")).toBe("none");
    expect(capEffort("provider-default", "low", order, "medium")).toBe("low");
    expect(capEffort("provider-default", "high", order, "medium")).toBe("provider-default");
    expect(capEffort("max", null, order, "medium")).toBe("max");
  });
  it("per-mode slots and caps", () => {
    const hi = pick(routing, "conversation and drafting", "high", { isPriceKnown: known });
    expect(hi).toMatchObject({ ok: true, slot: "best", ref: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" } });
    const sv = pick(routing, "planning and hard judgment", "saver", { isPriceKnown: known });
    expect(sv).toMatchObject({ ok: true, slot: "value", ref: { model: "gpt-6.1-sol", effort: "low" } });

    const bal = pick(routing, "planning and hard judgment", "balanced", { isPriceKnown: known });
    expect(bal).toMatchObject({ ok: true, slot: "best", ref: { model: "claude-opus-5-5", effort: "xhigh" } });
  });
  it("a disabled provider (alibaba) falls back to backup", () => {
    const r = pick(routing, "browser step execution", "balanced", { isPriceKnown: known });
    expect(r).toMatchObject({ ok: true, slot: "backup", ref: { provider: "openai", model: "gpt-6-astra", effort: "medium" }, candidatesSkipped: [{ slot: "value", why: "provider_disabled" }] });
  });
  it("skips models that failed in this task and providers with auth errors", () => {
    const r = pick(routing, "conversation and drafting", "high", { isPriceKnown: known, excluded: new Set(["anthropic/claude-opus-5-5"]) });
    expect(r).toMatchObject({ ok: true, slot: "backup", ref: { model: "gpt-6.1-sol" } });
    const r2 = pick(routing, "conversation and drafting", "high", { isPriceKnown: known, excludedProviders: new Set(["anthropic", "openai"]) });
    expect(r2).toEqual({ ok: false, reason: "no_candidate", routingVersion: routing.version });
  });
  it("does not pick unknown-price models (fx null)", () => {
    const book = new PriceBook([realPrices]);
    expect(pick(routing, "router", "balanced", { isPriceKnown: (p, m) => book.isKnown(p, m) })).toMatchObject({ ok: false, reason: "no_candidate" });
  });
  it("offline mode: pick, swap to fake, keep the original as routedFrom", () => {
    const r = pickOffline(routing, "conversation and drafting", "balanced", {});
    expect(r).toMatchObject({ ok: true, ref: { provider: "fake", model: "fake-1", effort: "low" }, routedFrom: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" } });
  });
  it("notification text: balanced/saver use Haiku none, high uses Sonnet low; without Haiku, backup Sonnet none (fallback cap)", () => {
    const p1031 = new PriceBook([parsePriceTable(JSON.parse(readFileSync(new URL("prices/2026-10-31.json", dataDir), "utf8")))], { now: () => new Date("2026-11-02T12:00:00+09:00") });
    const priced = { isPriceKnown: (p: string, m: string) => p1031.isKnown(p, m) };
    expect(pick(routing, "notification text", "balanced", priced)).toMatchObject({ ok: true, slot: "value", ref: { provider: "anthropic", model: "claude-haiku-5-5", effort: "none" } });
    expect(pick(routing, "notification text", "saver", priced)).toMatchObject({ ok: true, slot: "value", ref: { model: "claude-haiku-5-5", effort: "none" } });
    expect(pick(routing, "notification text", "high", priced)).toMatchObject({ ok: true, slot: "best", ref: { model: "claude-sonnet-5-5", effort: "low" } });
    expect(pick(routing, "notification text", "balanced", { ...priced, excluded: new Set(["anthropic/claude-haiku-5-5"]) })).toMatchObject({ ok: true, slot: "backup", ref: { model: "claude-sonnet-5-5", effort: "none" } });
    expect(routing.version).toBe("routing-2026-11-09.1");
  });
  it("purpose -> routing kind: every kind exists and is routable in all three modes, even with only anthropic", () => {
    const p1031 = new PriceBook([parsePriceTable(JSON.parse(readFileSync(new URL("prices/2026-10-31.json", dataDir), "utf8")))], { now: () => new Date("2026-11-02T12:00:00+09:00") });
    const isPriceKnown = (p: string, m: string) => p1031.isKnown(p, m);
    expect(Object.keys(PURPOSE_ROUTING_KIND).sort()).toEqual(["draft_write", "minutes_extract", "register_rewrite", "study_sheet"]);
    for (const [purpose, kind] of Object.entries(PURPOSE_ROUTING_KIND)) {
      expect(routing.taskKinds[kind], purpose).toBeDefined();
      for (const mode of ["high", "balanced", "saver"] as const) {
        expect(pick(routing, kind, mode, { isPriceKnown }), `${purpose} ${mode}`).toMatchObject({ ok: true });
        const onlyAnthropic = pick(routing, kind, mode, { isPriceKnown, excludedProviders: new Set(["openai", "google"]) });
        expect(onlyAnthropic, `${purpose} ${mode} anthropic only`).toMatchObject({ ok: true, ref: { provider: "anthropic" } });
      }
    }

    const anth = { isPriceKnown, excludedProviders: new Set(["openai", "google"]) };
    expect(PURPOSE_ROUTING_KIND.study_sheet).toBe("structured extraction");

    for (const [purpose, kind] of Object.entries(PURPOSE_ROUTING_KIND)) for (const mode of ["high", "balanced", "saver"] as const) {
      const r = pick(routing, kind, mode, anth);
      expect(r.ok && r.slot, `${purpose} ${mode}`).not.toBe("backup");
      expect(r.ok && r.ref.effort, `${purpose} ${mode}`).not.toBe("xhigh");
    }
    expect(pick(routing, PURPOSE_ROUTING_KIND.study_sheet, "balanced", anth)).toMatchObject({ slot: "value", ref: { model: "claude-haiku-5-5", effort: "medium" } });
    expect(pick(routing, PURPOSE_ROUTING_KIND.minutes_extract, "balanced", anth)).toMatchObject({ slot: "value", ref: { model: "claude-haiku-5-5", effort: "medium" } });
    expect(pick(routing, PURPOSE_ROUTING_KIND.register_rewrite, "balanced", anth)).toMatchObject({ slot: "value", ref: { model: "claude-sonnet-5-5", effort: "low" } });
  });
  it("fallback cap: when falling to another slot, effort never exceeds the original row effort", () => {
    const p1031 = new PriceBook([parsePriceTable(JSON.parse(readFileSync(new URL("prices/2026-10-31.json", dataDir), "utf8")))], { now: () => new Date("2026-11-02T12:00:00+09:00") });
    const anth = { isPriceKnown: (p: string, m: string) => p1031.isKnown(p, m), excludedProviders: new Set(["openai", "google"]) };

    expect(pick(routing, "research and summary", "high", anth)).toMatchObject({ ok: true, slot: "backup", ref: { model: "claude-sonnet-5-5", effort: "high" } });

    for (const m of ["high", "balanced", "saver"] as const) expect(pick(routing, "router", m, anth), m).toMatchObject({ ok: true, slot: "backup", ref: { model: "claude-sonnet-5-5", effort: "none" } });

    expect(pick(routing, "research and summary", "saver", anth)).toMatchObject({ slot: "backup", ref: { effort: "low" } });

    expect(pick(routing, "research and summary", "high", { isPriceKnown: anth.isPriceKnown })).toMatchObject({ slot: "best", ref: { model: "gpt-6-astra", effort: "high" } });

    const order = routing.modes.effortOrder; const rank = (x: string) => order.indexOf((x === "provider-default" ? routing.modes.providerDefaultCompareAs : x) as never);
    for (const [kind, e] of Object.entries(routing.taskKinds)) for (const m of ["high", "balanced", "saver"] as const) {
      const r = pick(routing, kind, m, anth); if (!r.ok) continue;
      const act = e.active ?? routing.modes.presets[m].overrides[kind]?.active ?? routing.modes.presets[m].active;
      if (r.slot !== act) expect(rank(r.ref.effort ?? "none") <= rank(e[act].effort), `${kind} ${m}`).toBe(true);
    }
  });
  it("unknown kind", () => {
    expect(pick(routing, "no such kind", "high", { isPriceKnown: known })).toMatchObject({ ok: false, reason: "unknown_kind" });
  });
});

describe("price table 2026-10-31 (fx 1450 KRW/USD assumed)", () => {
  const p1031 = parsePriceTable(JSON.parse(readFileSync(new URL("prices/2026-10-31.json", dataDir), "utf8")));
  const at = (iso: string) => () => new Date(iso);

  it("every routed model of enabled providers has a price", () => {
    const book = new PriceBook([p1031], { now: at("2026-10-31T12:00:00+09:00") });
    const used = new Set<string>();
    for (const e of Object.values(routing.taskKinds)) for (const s of [e.best, e.value, e.backup]) if (routing.enabledProviders.includes(s.provider)) used.add(`${s.provider}/${s.model}`);
    expect([...used].filter((k) => !book.isKnown(k.split("/")[0] ?? "", k.split("/")[1] ?? ""))).toEqual([]);
    expect(used.size).toBe(8);

    expect(pick(routing, "router", "balanced", { isPriceKnown: (p, m) => book.isKnown(p, m) })).toMatchObject({ ok: true, ref: { model: "gpt-6-luna" } });
  });

  it("uses the default fx and reports which fx was used", () => {
    const book = new PriceBook([p1031]);

    expect(book.cost("anthropic", "claude-sonnet-5-5", { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 })).toMatchObject({
      cost_mkrw: 17400, usd_micro: 12000, price_ref: "prices/2026-10-31.json#anthropic/claude-sonnet-5-5", estimated: false, fx: { mkrw_per_usd: 1_450_000 },
    });
    expect(DEFAULT_FX.mkrw_per_usd).toBe(p1031.fx.mkrw_per_usd);
  });

  it("a configured fx wins (fake table stays zero)", () => {
    const book = new PriceBook([p1031, FAKE_PRICE_TABLE], { fx: { mkrw_per_usd: 1_300_000, source: "settings" } });
    expect(book.cost("anthropic", "claude-sonnet-5-5", { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 })).toMatchObject({ cost_mkrw: 15600, fx: { mkrw_per_usd: 1_300_000, source: "settings" } });
    expect(book.cost("fake", "fake-1", { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 })?.cost_mkrw).toBe(0);
  });

  it("long-context: above 100k (haiku) or 272k (openai) the whole request is priced higher", () => {
    const book = new PriceBook([p1031]);
    expect(book.cost("anthropic", "claude-haiku-5-5", { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 })?.usd_micro).toBe(10_000);
    expect(book.cost("anthropic", "claude-haiku-5-5", { input: 90_000, output: 0, cacheRead: 10_001, cacheWrite: 0 })?.usd_micro).toBe(45_000 + 500);
    expect(book.cost("openai", "gpt-6.1-sol", { input: 272_001, output: 1000, cacheRead: 0, cacheWrite: 0 })?.usd_micro).toBe(1_088_004 + 15_000);
  });

  it("gemini-3.8-flash price is valid until 2026-12-31 only", () => {
    expect(new PriceBook([p1031], { now: at("2026-12-31T23:59:00+09:00") }).isKnown("google", "gemini-3.8-flash")).toBe(true);
    const jan = new PriceBook([p1031], { now: at("2027-01-01T00:00:00+09:00") });
    expect(jan.isKnown("google", "gemini-3.8-flash")).toBe(false);
    expect(jan.cost("google", "gemini-3.8-flash", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(jan.isKnown("anthropic", "claude-haiku-5-5")).toBe(true);
  });

  it("display amounts are approximate", () => {
    expect(formatKrwApprox(17400)).toBe("about KRW 17");
    expect(formatKrwApprox(1_234_567_890)).toBe("about KRW 1,234,568");
    expect(formatKrwApprox(400)).toBe("under KRW 1");
    expect(formatKrwApprox(0)).toBe("KRW 0");
  });
});
