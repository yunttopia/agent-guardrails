import { describe, expect, it } from "vitest";
import { COST_GUARD_SCHEMA, CostGuardInvalid, costGuardFileText, costGuardMkrw, DEFAULT_COST_GUARD, parseCostGuard, parseCostGuardText, type CostGuardInvalidReason } from "../../src/model/cost-guard.ts";
import * as model from "../../src/model/index.ts";

const ok = { schema: COST_GUARD_SCHEMA, daily_cap_krw: 3000, monthly_cap_krw: 30000 };
const why = (f: () => unknown): CostGuardInvalidReason | "no_throw" | "other" => {
  try { f(); return "no_throw"; } catch (e) { return e instanceof CostGuardInvalid ? e.reason : "other"; }
};

describe("cost-guard file parsing", () => {
  it("valid file gives two KRW Money values", () => {
    const c = parseCostGuard(ok);
    expect(c).toEqual({ day: { currency: "KRW", minor: 3000 }, month: { currency: "KRW", minor: 30000 } });
    expect(costGuardMkrw(c)).toEqual({ day: 3_000_000, month: 30_000_000 });
    expect(Object.isFrozen(c) && Object.isFrozen(c.day)).toBe(true);
  });
  it("day == month is accepted (boundary)", () => {
    expect(parseCostGuard({ ...ok, daily_cap_krw: 500, monthly_cap_krw: 500 }).day.minor).toBe(500);
  });
  it("defaults are KRW 3,000/day and 30,000/month and round-trip", () => {
    expect(DEFAULT_COST_GUARD).toEqual(ok);
    expect(Object.isFrozen(DEFAULT_COST_GUARD)).toBe(true);
    const text = costGuardFileText();
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseCostGuardText(text)).toEqual(parseCostGuard(ok));
  });
  it.each<[string, unknown, CostGuardInvalidReason]>([
    ["null", null, "not_object"],
    ["array", [ok], "not_object"],
    ["array with Object prototype", Object.setPrototypeOf(Object.assign([], ok), Object.prototype) as unknown, "not_object"],
    ["number", 3000, "not_object"],
    ["class instance", Object.assign(new (class X {})(), ok), "not_object"],
    ["wrong schema", { ...ok, schema: "agent-guardrails.cost-guard/v1" }, "schema"],
    ["missing schema", { daily_cap_krw: 3000, monthly_cap_krw: 30000 }, "missing_key"],
    ["unknown key", { ...ok, note: "x" }, "unknown_key"],
    ["missing key (month)", { schema: COST_GUARD_SCHEMA, daily_cap_krw: 3000 }, "missing_key"],
    ["numeric string", { ...ok, daily_cap_krw: "3000" }, "not_number"],
    ["null value", { ...ok, monthly_cap_krw: null }, "not_number"],
    ["fraction", { ...ok, daily_cap_krw: 3000.5 }, "not_integer"],
    ["NaN", { ...ok, daily_cap_krw: Number.NaN }, "not_integer"],
    ["Infinity", { ...ok, monthly_cap_krw: Number.POSITIVE_INFINITY }, "not_integer"],
    ["0", { ...ok, daily_cap_krw: 0 }, "not_positive"],
    ["negative", { ...ok, daily_cap_krw: -1 }, "not_positive"],
    ["x1000 exceeds safe integer", { ...ok, daily_cap_krw: 3000, monthly_cap_krw: Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1 }, "too_large"],
    ["day > month", { ...ok, daily_cap_krw: 30001, monthly_cap_krw: 30000 }, "day_over_month"],
  ])("invalid: %s", (_n, raw, reason) => {
    expect(why(() => parseCostGuard(raw))).toBe(reason);
  });
  it("accepts the largest safe value", () => {
    const max = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
    expect(parseCostGuard({ ...ok, daily_cap_krw: 1, monthly_cap_krw: max }).month.minor).toBe(max);
  });
  it("accepts null-prototype objects", () => {
    const o = Object.assign(Object.create(null) as Record<string, unknown>, ok);
    expect(parseCostGuard(o).day.minor).toBe(3000);
  });
  it("syntax errors give not_json without echoing the file", () => {
    const secretish = '{"schema":"agent-guardrails.cost-guard/v0","daily_cap_krw": 12345abc';
    let msg = "";
    try { parseCostGuardText(secretish); } catch (e) { expect(e).toBeInstanceOf(CostGuardInvalid); expect((e as CostGuardInvalid).reason).toBe("not_json"); msg = (e as Error).message; }
    expect(msg).not.toContain("12345");
    expect(msg).not.toContain("schema");
  });
  it("value errors do not echo the value", () => {
    try { parseCostGuard({ ...ok, daily_cap_krw: 98765.4 }); } catch (e) { expect((e as Error).message).not.toContain("98765"); }
  });
  it("strips one leading BOM; two BOMs give not_json", () => {
    expect(parseCostGuardText(`﻿${costGuardFileText()}`)).toEqual(parseCostGuard(ok));
    expect(why(() => parseCostGuardText(`﻿﻿${costGuardFileText()}`))).toBe("not_json");
  });
  it("exported from the model entry point", () => {
    expect(model.parseCostGuard).toBe(parseCostGuard);
    expect(model.DEFAULT_COST_GUARD).toBe(DEFAULT_COST_GUARD);
  });
});
