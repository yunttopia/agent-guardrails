// Mints and verifies HMAC-signed approval tokens bound to a task, plan hash and action.
import { hmacHex, isObj, jcs, kstParts, safeEqual, toMillis, type Obj } from "./common.ts";

const ACTION_RISK: Record<string, "money_out" | "outbound"> = {
  "message.send": "outbound", "form.submit_outbound": "outbound",
  "refund.submit": "money_out", "transfer.submit": "money_out", "payment.request": "money_out", "booking.reserve": "money_out",
};

export interface IssueRequest {
  token_id: string;
  task_id: string; case_id: string | null; action: string; plan_sha256: string;
  issued_by: "user" | "stage_rule"; card_id: string | null; stage: 1 | 2 | 3 | 4;
  rule_id: string | null; command_ref: { kind: "user_message" | "standing_order"; id: string } | null; scope_sha256: string | null;
  bind: { amount: { currency: "KRW" | "USD"; minor: number } | null; account_fp: string | null; recipient_fp: string | null;
          draft_sha256: string | null; target: { field: string; value: string } | null; recipients_fp: string[] | null };
  approval_event: { task_id: string; seq: number }; chain_head_at_approval: string;
  issued_at: string; execution_window: { start: string; end: string } | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function kstIso(ms: number): string {
  const p = kstParts(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${two(p.m)}-${two(p.d)}T${two(p.H)}:${two(p.M)}:${two(p.S)}+09:00`;
}

export function mintToken(req: IssueRequest, keys: { approval_key_hex: string }): Obj {
  const risk = ACTION_RISK[req.action];
  if (!risk) throw new Error(`action is not in the approval-required list: ${req.action}`);
  if (req.issued_by === "user") {
    if (typeof req.card_id !== "string" || req.rule_id !== null || req.command_ref !== null || req.scope_sha256 !== null) throw new Error("user token fields invalid");
  } else {
    if (req.card_id !== null || !req.rule_id || !req.command_ref || !req.scope_sha256) throw new Error("stage-rule token fields invalid");
    if (req.execution_window !== null) throw new Error("stage-rule tokens have no execution window");
    if (req.stage === 1) throw new Error("stage 1 requires a human approval (no stage-rule tokens)");
  }
  if (!isObj(req.bind)) throw new Error("missing bind");
  const issued = toMillis(req.issued_at, "issued_at");
  let expires: number;
  if (req.execution_window) {
    const s = toMillis(req.execution_window.start, "execution_window.start");
    const e = toMillis(req.execution_window.end, "execution_window.end");
    if (!(issued <= s && s < e && e - s <= 12 * HOUR && s - issued <= 24 * HOUR)) throw new Error("execution window out of bounds");
    expires = e;
  } else if (req.issued_by === "stage_rule") expires = issued + 5 * MIN;
  else expires = issued + (risk === "money_out" ? 30 * MIN : 24 * HOUR);
  const token: Obj = {
    schema: "agent-guardrails.approval/v0", token_id: req.token_id, task_id: req.task_id, case_id: req.case_id, card_id: req.card_id,
    action: req.action, plan_sha256: req.plan_sha256, issued_at: req.issued_at,
    expires_at: req.execution_window ? req.execution_window.end : kstIso(expires),
    execution_window: req.execution_window, chain_head_at_approval: req.chain_head_at_approval,
    issued_by: req.issued_by, stage: req.stage, rule_id: req.rule_id, command_ref: req.command_ref, scope_sha256: req.scope_sha256,
    max_uses: 1, approval_event: req.approval_event, bind: req.bind,
  };
  token["mac"] = "hmac-sha256:" + hmacHex(keys.approval_key_hex, jcs(token));
  return token;
}

export type VerifyFailure = "malformed" | "bad_mac" | "expired" | "not_yet" | "mismatch";
export interface VerifyOptions { approval_key_hex: string; now: Date; task_id: string; plan_sha256: string; action: string }

/** Checks MAC (constant time), expiry / execution window, and that task, plan and action match. Does not count uses. */
export function verifyToken(token: unknown, o: VerifyOptions): { ok: true } | { ok: false; reason: VerifyFailure } {
  if (!isObj(token) || typeof token["mac"] !== "string" || typeof token["expires_at"] !== "string") return { ok: false, reason: "malformed" };
  const { mac, ...rest } = token;
  let body: string;
  try { body = jcs(rest); } catch { return { ok: false, reason: "malformed" }; }   // e.g. a non-integer number edited into the token
  if (!safeEqual(mac as string, "hmac-sha256:" + hmacHex(o.approval_key_hex, body))) return { ok: false, reason: "bad_mac" };
  const now = o.now.getTime();
  let expires: number, start: number | null;
  try {
    expires = toMillis(token["expires_at"], "expires_at");
    const w = token["execution_window"];
    start = isObj(w) ? toMillis(w["start"], "execution_window.start") : null;
  } catch { return { ok: false, reason: "malformed" }; }
  if (now >= expires) return { ok: false, reason: "expired" };
  if (start !== null && now < start) return { ok: false, reason: "not_yet" };
  if (token["task_id"] !== o.task_id || token["plan_sha256"] !== o.plan_sha256 || token["action"] !== o.action) return { ok: false, reason: "mismatch" };
  return { ok: true };
}
