// Parses the daily/monthly cost cap file.
import type { Money } from "../types.ts";

export const COST_GUARD_SCHEMA = "agent-guardrails.cost-guard/v0";

export interface CostGuardFile {
  readonly schema: typeof COST_GUARD_SCHEMA;
  readonly daily_cap_krw: number;
  readonly monthly_cap_krw: number;
}

export interface CostGuard { readonly day: Money; readonly month: Money }

export const DEFAULT_COST_GUARD: CostGuardFile = Object.freeze({ schema: COST_GUARD_SCHEMA, daily_cap_krw: 3000, monthly_cap_krw: 30000 });

export type CostGuardInvalidReason = "not_json" | "not_object" | "schema" | "unknown_key" | "missing_key" | "not_number" | "not_integer" | "not_positive" | "too_large" | "day_over_month";

export class CostGuardInvalid extends Error {
  readonly reason: CostGuardInvalidReason;
  constructor(reason: CostGuardInvalidReason) {
    super(`cost-guard read failed: ${reason}`);
    this.name = "CostGuardInvalid";
    this.reason = reason;
  }
}

const KEYS = ["schema", "daily_cap_krw", "monthly_cap_krw"] as const;

function won(v: unknown): number {
  if (typeof v !== "number") throw new CostGuardInvalid("not_number");
  if (!Number.isInteger(v)) throw new CostGuardInvalid("not_integer");
  if (v <= 0) throw new CostGuardInvalid("not_positive");
  if (!Number.isSafeInteger(v * 1000)) throw new CostGuardInvalid("too_large");
  return v;
}

export function parseCostGuard(raw: unknown): CostGuard {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new CostGuardInvalid("not_object");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) throw new CostGuardInvalid("not_object");
  const o = raw as Record<string, unknown>;
  const own = Object.keys(o);
  if (own.some((k) => !(KEYS as readonly string[]).includes(k))) throw new CostGuardInvalid("unknown_key");
  if (KEYS.some((k) => !Object.prototype.hasOwnProperty.call(o, k))) throw new CostGuardInvalid("missing_key");
  if (o["schema"] !== COST_GUARD_SCHEMA) throw new CostGuardInvalid("schema");
  const day = won(o["daily_cap_krw"]);
  const month = won(o["monthly_cap_krw"]);
  if (day > month) throw new CostGuardInvalid("day_over_month");
  return Object.freeze({ day: Object.freeze({ currency: "KRW" as const, minor: day }), month: Object.freeze({ currency: "KRW" as const, minor: month }) });
}

export function parseCostGuardText(text: string): CostGuard {
  let raw: unknown;
  try { raw = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text); } catch { throw new CostGuardInvalid("not_json"); }
  return parseCostGuard(raw);
}

export function costGuardFileText(f: CostGuardFile = DEFAULT_COST_GUARD): string {
  return `${JSON.stringify({ schema: f.schema, daily_cap_krw: f.daily_cap_krw, monthly_cap_krw: f.monthly_cap_krw }, null, 2)}\n`;
}

export function costGuardMkrw(c: CostGuard): { day: number; month: number } {
  return { day: c.day.minor * 1000, month: c.month.minor * 1000 };
}
