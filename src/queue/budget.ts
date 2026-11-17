// SQLite budget store with day/month caps, reservations and settlement.
import { randomUUID } from "node:crypto";
import type { CoreDb } from "../db.ts";
import type { BudgetKey, BudgetRefusal, BudgetStore, IsoTime } from "../types.ts";

const REFUSAL_RANK: Record<BudgetRefusal["scope"], number> = { day: 1, month: 2, task: 3, unset: 4 };

export class SqliteBudgetStore implements BudgetStore {
  private readonly db: CoreDb;

  constructor(db: CoreDb) {
    this.db = db;
  }

  setCap(key: BudgetKey, capMkrw: number | null): void {
    if (capMkrw !== null && (!Number.isSafeInteger(capMkrw) || capMkrw < 0)) throw new Error("cap must be a non-negative integer (1/1000 KRW)");
    this.db.sql.prepare("INSERT INTO budget_caps(scope, id, cap_mkrw) VALUES (?, ?, ?) ON CONFLICT(scope, id) DO UPDATE SET cap_mkrw = excluded.cap_mkrw")
      .run(key.scope, key.id, capMkrw);
  }

  private cap(key: BudgetKey): number | null {
    const id = key.scope === "month" || key.scope === "day" ? "default" : key.id;
    const r = this.db.sql.prepare("SELECT cap_mkrw FROM budget_caps WHERE scope = ? AND id = ?").get(key.scope, id) as { cap_mkrw: number | null } | undefined;
    return r?.cap_mkrw ?? null;
  }

  private used(key: BudgetKey): number {
    const r = this.db.sql.prepare(
      `SELECT COALESCE(SUM(CASE WHEN r.state = 'settled' THEN r.actual_mkrw WHEN r.state = 'reserved' THEN r.estimate_mkrw ELSE 0 END), 0) AS s
       FROM budget_res r JOIN budget_res_keys k ON k.res_id = r.id WHERE k.scope = ? AND k.key_id = ?`).get(key.scope, key.id) as { s: number };
    return Number(r.s);
  }

  spent(key: BudgetKey): { capMkrw: number | null; spentMkrw: number } {
    return { capMkrw: this.cap(key), spentMkrw: this.used(key) };
  }

  reserve(keys: BudgetKey[], estimateMkrw: number, at: IsoTime): { ok: true; reservationId: string } | BudgetRefusal {
    if (!Number.isSafeInteger(estimateMkrw) || estimateMkrw < 0) throw new Error("estimate must be a non-negative integer");
    if (!keys.some((k) => k.scope === "month") || !keys.some((k) => k.scope === "day")) throw new Error("a reservation needs both a day and a month key");
    return this.db.tx(() => {
      let worst: BudgetRefusal | null = null;
      const consider = (r: BudgetRefusal) => { if (!worst || REFUSAL_RANK[r.scope] > REFUSAL_RANK[worst.scope]) worst = r; };
      for (const k of keys) {
        const cap = this.cap(k);
        const spent = this.used(k);
        if (cap === null) {
          if (k.scope !== "task") consider({ ok: false, scope: "unset", period: null, capMkrw: null, spentMkrw: spent });
          continue;
        }
        if (spent + estimateMkrw > cap) consider({ ok: false, scope: k.scope, period: k.scope === "task" ? null : k.id, capMkrw: cap, spentMkrw: spent });
      }
      if (worst) return worst;
      const id = randomUUID();
      this.db.sql.prepare("INSERT INTO budget_res(id, keys, estimate_mkrw, actual_mkrw, state, at) VALUES (?, ?, ?, NULL, 'reserved', ?)").run(id, JSON.stringify(keys), estimateMkrw, at);
      for (const k of keys) this.db.sql.prepare("INSERT INTO budget_res_keys(res_id, scope, key_id) VALUES (?, ?, ?)").run(id, k.scope, k.id);
      return { ok: true as const, reservationId: id };
    });
  }

  settle(reservationId: string, actualMkrw: number, at: IsoTime): void {
    if (!Number.isSafeInteger(actualMkrw) || actualMkrw < 0) throw new Error("actual must be a non-negative integer");
    const r = this.db.sql.prepare("UPDATE budget_res SET state = 'settled', actual_mkrw = ?, at = ? WHERE id = ? AND state = 'reserved'").run(actualMkrw, at, reservationId) as { changes: number | bigint };
    if (Number(r.changes) !== 1) throw new Error(`no open reservation: ${reservationId}`);
  }

  release(reservationId: string): void {
    this.db.sql.prepare("UPDATE budget_res SET state = 'released' WHERE id = ? AND state = 'reserved'").run(reservationId);
  }
}
