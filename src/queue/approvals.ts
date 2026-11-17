// Stores approval tokens and counts their uses.
import type { CoreDb } from "../db.ts";
import { verifyToken, type VerifyFailure, type VerifyOptions } from "../gate/mint-token.ts";

export type IssuedBy = "user" | "stage_rule";
export type Token = Record<string, unknown>;


export class ApprovalStore {
  private readonly db: CoreDb;
  constructor(db: CoreDb) { this.db = db; }

  get(tokenId: string): { token: Token; uses: number; revoked: boolean } | null {
    const r = this.db.sql.prepare("SELECT token, uses, revoked_at FROM approvals WHERE token_id = ?").get(tokenId) as { token: string; uses: number; revoked_at: string | null } | undefined;
    if (!r) return null;
    const token = JSON.parse(r.token) as Token;
    const revoked = r.revoked_at !== null;
    const max = typeof token["max_uses"] === "number" ? token["max_uses"] : 1;
    return { token, uses: revoked ? Math.max(r.uses, max) : r.uses, revoked };
  }

  usedTimes(tokenId: string): number | null {
    const r = this.db.sql.prepare("SELECT uses FROM approvals WHERE token_id = ?").get(tokenId) as { uses: number } | undefined;
    return r ? r.uses : null;
  }

  revokeOpenFor(taskId: string, at: string): string[] {
    const rows = this.db.sql.prepare("SELECT token_id, token, uses FROM approvals WHERE task_id = ? AND revoked_at IS NULL").all(taskId) as Array<{ token_id: string; token: string; uses: number }>;
    const open = rows.filter((r) => { const max = (JSON.parse(r.token) as Token)["max_uses"]; return r.uses < (typeof max === "number" ? max : 1); }).map((r) => r.token_id);
    const st = this.db.sql.prepare("UPDATE approvals SET revoked_at = ? WHERE token_id = ?");
    for (const id of open) st.run(at, id);
    return open;
  }

  has(tokenId: string): boolean {
    return this.db.sql.prepare("SELECT 1 FROM approvals WHERE token_id = ?").get(tokenId) !== undefined;
  }

  revoke(tokenId: string, at: string): number {
    return Number((this.db.sql.prepare("UPDATE approvals SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL").run(at, tokenId) as { changes: number | bigint }).changes);
  }

  /** Verifies the stored token, then counts one use only if it is not revoked and has uses left (one atomic row update). */
  consume(tokenId: string, check: VerifyOptions): { ok: true } | { ok: false; reason: VerifyFailure | "not_found" | "revoked" | "used_up" } {
    return this.db.tx(() => {
      const r = this.get(tokenId);
      if (!r) return { ok: false as const, reason: "not_found" as const };
      if (r.revoked) return { ok: false as const, reason: "revoked" as const };
      const v = verifyToken(r.token, check);
      if (!v.ok) return v;
      const ch = this.db.sql.prepare("UPDATE approvals SET uses = uses + 1 WHERE token_id = ? AND revoked_at IS NULL AND uses < COALESCE(json_extract(token, '$.max_uses'), 1)").run(tokenId) as { changes: number | bigint };
      return Number(ch.changes) === 1 ? { ok: true as const } : { ok: false as const, reason: "used_up" as const };
    });
  }

  save(req: { token_id: string; task_id: string; issued_by: IssuedBy }, token: Token, at: string): void {
    if (token["token_id"] !== req.token_id) throw new Error(`minted token_id differs from request: ${String(token["token_id"])}`);
    const by = token["issued_by"] ?? "user";
    if (by !== req.issued_by) throw new Error(`minted issued_by differs from request: ${String(by)}`);
    this.db.sql.prepare("INSERT INTO approvals(token_id, task_id, issued_by, token, uses, at) VALUES (?, ?, ?, ?, 0, ?)")
      .run(req.token_id, req.task_id, req.issued_by, JSON.stringify(token), at);
  }
}
