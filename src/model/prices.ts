import { seoulDate } from "../util/time.ts";
// Integer price tables (USD micro per 1M tokens) and KRW conversion.
export interface PriceRates { input: number; output: number; cache_read: number | null; cache_write: number | null }
export interface PriceTier extends PriceRates { inputTokensAbove: number }
export interface ModelPrice extends PriceRates {
  provider: string;
  tiers: PriceTier[] | null;

  valid_until?: string | null;
  source?: string | null;
  checked?: string | null;
  note?: string;

  context_tokens?: number | null;

  context_source?: string | null;
  context_checked?: string | null;

  context_note?: string;
}
export interface PriceTable {
  schema: "agent-guardrails.prices/v0";
  version: string;
  unit: "usd_micro_per_1m_tokens";
  fx: { mkrw_per_usd: number | null; source: string | null; checked: string | null };
  models: Record<string, ModelPrice>;
}

export interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface PricedCost {
  cost_mkrw: number;

  usd_micro: number;
  price_ref: string;

  estimated: boolean;

  fx: { mkrw_per_usd: number; source: string | null };
}

export interface PriceBookOptions {
  fx?: { mkrw_per_usd: number; source: string } | null;
  now?: () => Date;
}

export const FAKE_PRICE_TABLE: PriceTable = {
  schema: "agent-guardrails.prices/v0",
  version: "fake",
  unit: "usd_micro_per_1m_tokens",
  fx: { mkrw_per_usd: 1_000_000, source: "fake (zero price, no effect)", checked: null },
  models: { "fake-1": { provider: "fake", input: 0, output: 0, cache_read: 0, cache_write: 0, tiers: null } },
};

export const ASSUMED_CONTEXT_CHARS = 200_000;

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

export function parsePriceTable(raw: unknown): PriceTable {
  const t = raw as PriceTable;
  if (t?.schema !== "agent-guardrails.prices/v0" || t.unit !== "usd_micro_per_1m_tokens" || typeof t.version !== "string") {
    throw new Error("price table: schema/unit/version");
  }
  if (t.fx?.mkrw_per_usd !== null && !isNonNegInt(t.fx?.mkrw_per_usd)) throw new Error("price table: fx.mkrw_per_usd is not an integer");
  for (const [id, m] of Object.entries(t.models ?? {})) {
    for (const k of ["input", "output"] as const) {
      if (m[k] !== null && !isNonNegInt(m[k])) throw new Error(`price table: ${id}.${k} is not an integer`);
    }
    for (const k of ["cache_read", "cache_write"] as const) {
      if (m[k] !== null && !isNonNegInt(m[k])) throw new Error(`price table: ${id}.${k} is not an integer`);
    }
    for (const tier of m.tiers ?? []) {
      for (const k of ["inputTokensAbove", "input", "output"] as const) {
        if (!isNonNegInt(tier[k])) throw new Error(`price table: ${id}.tiers.${k} is not an integer`);
      }
    }
    if (m.valid_until != null && !/^\d{4}-\d{2}-\d{2}$/.test(m.valid_until)) throw new Error(`price table: ${id}.valid_until format`);

    if (m.context_tokens != null && !(isNonNegInt(m.context_tokens) && m.context_tokens > 0)) throw new Error(`price table: ${id}.context_tokens is not a positive integer`);
  }
  return t;
}

function divRoundHalfUp(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (2n * d);
}

export function formatKrwApprox(mkrw: number): string {
  if (mkrw <= 0) return "KRW 0";
  if (mkrw < 1000) return "under KRW 1";
  return `about KRW ${Math.round(mkrw / 1000).toLocaleString("en-US")}`;
}

export const DEFAULT_FX = { mkrw_per_usd: 1_450_000, source: "fixed 1450 KRW/USD (assumption; override via PriceBook options)" } as const;

export class PriceBook {
  private readonly tables: PriceTable[];
  private readonly opts: PriceBookOptions;
  constructor(tables: PriceTable[], opts: PriceBookOptions = {}) {
    this.tables = tables;
    this.opts = opts;
  }

  private fxFor(table: PriceTable): { mkrw_per_usd: number; source: string | null } | null {
    if (table.version !== "fake" && this.opts.fx) return this.opts.fx;
    return table.fx.mkrw_per_usd === null ? null : { mkrw_per_usd: table.fx.mkrw_per_usd, source: table.fx.source };
  }

  private find(provider: string, model: string): { table: PriceTable; price: ModelPrice } | null {
    for (const table of this.tables) {
      const price = table.models[model];
      if (price && price.provider === provider) return { table, price };
    }
    return null;
  }

  contextWindowOf(provider: string, model: string): number | null {
    return this.find(provider, model)?.price.context_tokens ?? null;
  }

  priceRef(provider: string, model: string): string {
    const hit = this.find(provider, model);
    return `prices/${hit ? hit.table.version : "unknown"}.json#${provider}/${model}`;
  }

  isKnown(provider: string, model: string): boolean {
    const hit = this.find(provider, model);
    if (hit === null || this.fxFor(hit.table) === null || hit.price.input === null || hit.price.output === null) return false;
    const until = hit.price.valid_until;
    return until == null || seoulDate((this.opts.now ?? (() => new Date()))()) <= until;
  }

  private rates(price: ModelPrice, promptTokens: number): PriceRates {
    let best: PriceRates = price;
    let above = -1;
    for (const tier of price.tiers ?? []) {
      if (tier.inputTokensAbove < promptTokens && tier.inputTokensAbove > above) {
        best = tier;
        above = tier.inputTokensAbove;
      }
    }
    return best;
  }

  cost(provider: string, model: string, t: TokenCounts): PricedCost | null {
    const hit = this.find(provider, model);
    if (!hit || !this.isKnown(provider, model)) return null;
    const r = this.rates(hit.price, t.input + t.cacheRead + t.cacheWrite);
    const estimated = (r.cache_read === null && t.cacheRead > 0) || (r.cache_write === null && t.cacheWrite > 0);
    const cacheRead = r.cache_read ?? r.input;

    let cacheWriteNum = BigInt(r.input) * 5n;
    let cacheWriteDen = 4n;
    if (r.cache_write !== null) {
      cacheWriteNum = BigInt(r.cache_write);
      cacheWriteDen = 1n;
    }

    const microTimesMillion =
      (BigInt(t.input) * BigInt(r.input) + BigInt(t.output) * BigInt(r.output) + BigInt(t.cacheRead) * BigInt(cacheRead)) * cacheWriteDen +
      BigInt(t.cacheWrite) * cacheWriteNum;
    const fxUsed = this.fxFor(hit.table) as { mkrw_per_usd: number; source: string | null };
    const fx = BigInt(fxUsed.mkrw_per_usd);
    const cost_mkrw = Number(divRoundHalfUp(microTimesMillion * fx, 10n ** 12n * cacheWriteDen));
    const usd_micro = Number(divRoundHalfUp(microTimesMillion, 10n ** 6n * cacheWriteDen));
    return { cost_mkrw, usd_micro, price_ref: this.priceRef(provider, model), estimated, fx: fxUsed };
  }

  worstCase(provider: string, model: string, inputTokensEstimate: number, maxOutputTokens: number): PricedCost | null {
    const plain = this.cost(provider, model, { input: inputTokensEstimate, output: maxOutputTokens, cacheRead: 0, cacheWrite: 0 });
    const written = this.cost(provider, model, { input: 0, output: maxOutputTokens, cacheRead: 0, cacheWrite: inputTokensEstimate });
    if (!plain || !written) return null;
    return written.cost_mkrw > plain.cost_mkrw ? written : plain;
  }
}
