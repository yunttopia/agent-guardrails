// TSV cost ledger: one row per model call.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const LEDGER_HEADER = [
  "date", "run_id", "purpose", "provider", "model", "calls", "input_tokens", "output_tokens", "cache_read_tokens",
  "usd_estimate", "usd_actual", "krw_rate", "krw_actual", "funding", "basis", "cache_write_tokens",
] as const;

export const LEDGER_HEADER_V1 = LEDGER_HEADER.slice(0, 15);

export type FundingSource = "anthropic-credit" | "card" | "none";

export interface LedgerRow {
  date: string;
  runId: string;
  purpose: string;
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;

  cacheWriteTokens: number | null;
  usdEstimateMicro: number | null;
  usdActualMicro: number | null;

  krwRate: string | null;
  krwActualMkrw: number | null;
  funding: FundingSource;
  basis: string;
}

export interface LedgerSink { append(row: LedgerRow): void }

function cell(v: string): string {
  return v.replace(/[\t\r\n]+/g, " ");
}
function usd(micro: number | null): string {
  if (micro === null) return "";
  const s = String(micro).padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}
function krw(mkrw: number | null): string {
  if (mkrw === null) return "";
  const s = String(mkrw).padStart(4, "0");
  return `${s.slice(0, -3)}.${s.slice(-3)}`;
}

export function formatLedgerRow(r: LedgerRow): string {
  return [
    r.date, r.runId, r.purpose, r.provider, r.model, String(r.calls), String(r.inputTokens), String(r.outputTokens), String(r.cacheReadTokens),
    usd(r.usdEstimateMicro), usd(r.usdActualMicro), r.krwRate ?? "", krw(r.krwActualMkrw), r.funding, r.basis,
    r.cacheWriteTokens === null ? "" : String(r.cacheWriteTokens),
  ].map(cell).join("\t");
}

function upgradeHeader(path: string): void {
  const text = readFileSync(path, "utf8");
  const nl = text.indexOf("\n");
  const first = nl < 0 ? text : text.slice(0, nl);
  if (first !== LEDGER_HEADER_V1.join("\t")) return;
  writeFileSync(path, LEDGER_HEADER.join("\t") + (nl < 0 ? "\n" : text.slice(nl)), "utf8");
}

export function createFileLedger(path: string): LedgerSink {
  let checked = false;
  return {
    append(row) {
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, LEDGER_HEADER.join("\t") + "\n", "utf8");
      } else if (!checked) {
        upgradeHeader(path);
      }
      checked = true;
      appendFileSync(path, formatLedgerRow(row) + "\n", "utf8");
    },
  };
}

export function createMemoryLedger(): LedgerSink & { rows: LedgerRow[] } {
  const rows: LedgerRow[] = [];
  return { rows, append: (row) => void rows.push(row) };
}
