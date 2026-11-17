import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLedger, formatLedgerRow, LEDGER_HEADER, LEDGER_HEADER_V1, type LedgerRow } from "../../src/model/ledger.ts";

const row: LedgerRow = {
  date: "2026-10-31T01:00:00Z", runId: "t1/a1", purpose: "worker_turn", provider: "anthropic", model: "claude-haiku-5-5", calls: 1,
  inputTokens: 50, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 30, usdEstimateMicro: 5_087, usdActualMicro: 87, krwRate: "1400\t(test)", krwActualMkrw: 122,
  funding: "anthropic-credit", basis: "prices/t.json#anthropic/claude-haiku-5-5",
};

describe("cost ledger", () => {
  it("formats decimals and strips tabs", () => {
    expect(formatLedgerRow(row).split("\t")).toEqual([
      "2026-10-31T01:00:00Z", "t1/a1", "worker_turn", "anthropic", "claude-haiku-5-5", "1", "50", "7", "20",
      "0.005087", "0.000087", "1400 (test)", "0.122", "anthropic-credit", "prices/t.json#anthropic/claude-haiku-5-5", "30",
    ]);
    expect(formatLedgerRow({ ...row, cacheWriteTokens: null }).split("\t")).toHaveLength(16);
    expect(formatLedgerRow({ ...row, cacheWriteTokens: null }).split("\t")[15]).toBe("");
    expect(formatLedgerRow({ ...row, cacheWriteTokens: 0 }).split("\t")[15]).toBe("0");
    expect(formatLedgerRow({ ...row, usdActualMicro: 0, krwActualMkrw: 0, usdEstimateMicro: null, krwRate: null }).split("\t").slice(9, 13)).toEqual(["", "0.000000", "", "0.000"]);
  });
  it("upgrades an old 15-column header in place and leaves old rows as they are", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      const p = join(dir, "ledger.tsv");
      const oldRow = formatLedgerRow(row).split("\t").slice(0, 15).join("\t");
      writeFileSync(p, LEDGER_HEADER_V1.join("\t") + "\n" + oldRow + "\n", "utf8");
      createFileLedger(p).append(row);
      const lines = readFileSync(p, "utf8").split("\n");
      expect(lines[0]).toBe(LEDGER_HEADER.join("\t"));
      expect(lines[1]).toBe(oldRow);
      expect(lines[1]?.split("\t")).toHaveLength(15);
      expect(lines[2]?.split("\t")).toHaveLength(16);
      expect(lines).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("leaves an unknown header untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      const p = join(dir, "ledger.tsv");
      writeFileSync(p, "hand-edited header\n", "utf8");
      createFileLedger(p).append(row);
      expect(readFileSync(p, "utf8").split("\n")[0]).toBe("hand-edited header");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("writes the header first when the file is new", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      const p = join(dir, "sub", "ledger.tsv");
      const l = createFileLedger(p);
      l.append(row);
      l.append(row);
      const lines = readFileSync(p, "utf8").split("\n");
      expect(lines[0]).toBe(LEDGER_HEADER.join("\t"));
      expect(lines).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
