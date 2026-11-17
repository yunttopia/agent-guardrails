import { describe, expect, it } from "vitest";
import { hmacHex, jcs } from "../src/gate/common.ts";
import { mintToken, verifyToken, type IssueRequest } from "../src/gate/mint-token.ts";
import { duplicateStepIds, planHasDuplicateStepId } from "../src/gate/step-id-unique.ts";
import { planHasUnderstatedStep, riskUnderstated } from "../src/gate/step-risk.ts";

const KEY = "ab".repeat(32);
const plan = (steps: Array<Record<string, unknown>>) => ({ items: [{ steps }] });

describe("step risk", () => {
  it("flags a step that declares less risk than its tool", () => {
    expect(riskUnderstated("none", "outbound")).toBe(true);
    expect(riskUnderstated("outbound", "outbound")).toBe(false);
    expect(riskUnderstated("money_out", "outbound")).toBe(false);
  });
  it("treats unknown tool risk as highest and unknown step risk as lowest", () => {
    expect(riskUnderstated("outbound", "weird")).toBe(true);
    expect(riskUnderstated("money_out", "weird")).toBe(false);
    expect(riskUnderstated("weird", "none")).toBe(true);
  });
  it("flags understated steps; unknown or missing tools count as highest risk", () => {
    const risks = { "message.send": "outbound", "docs.read": "none" } as const;
    expect(planHasUnderstatedStep(plan([{ tool: "message.send", risk: "none" }]), risks)).toBe(true);
    expect(planHasUnderstatedStep(plan([{ tool: "message.send", risk: "outbound" }, { tool: "docs.read", risk: "none" }]), risks)).toBe(false);
    expect(planHasUnderstatedStep(plan([{ tool: "wire.transfer", risk: "none" }]), risks)).toBe(true);
    expect(planHasUnderstatedStep(plan([{ tool: "wire.transfer", risk: "money_out" }]), risks)).toBe(false);
    expect(planHasUnderstatedStep(plan([{ risk: "outbound" }]), risks)).toBe(true);
  });
  it("refuses plans whose steps are not objects", () => {
    const risks = { "message.send": "outbound" } as const;
    for (const bad of ["message.send", null, 1, ["message.send"]]) expect(planHasUnderstatedStep({ items: [{ steps: [bad] }] }, risks)).toBe(true);
  });
});

describe("step id uniqueness", () => {
  it("lists each duplicated step id once", () => {
    const p = plan([{ step_id: "a" }, { step_id: "b" }, { step_id: "a" }, { step_id: "a" }]);
    expect(duplicateStepIds(p)).toEqual(["a"]);
    expect(planHasDuplicateStepId(p)).toBe(true);
    expect(planHasDuplicateStepId(plan([{ step_id: "a" }, { step_id: "b" }]))).toBe(false);
  });
});

describe("approval tokens", () => {
  const base = (over: Partial<IssueRequest> = {}): IssueRequest => ({
    token_id: "tok-1", task_id: "t-1", case_id: null, action: "message.send", plan_sha256: "sha256:" + "1".repeat(64),
    issued_by: "user", card_id: "card-1", stage: 1, rule_id: null, command_ref: null, scope_sha256: null,
    bind: { amount: null, account_fp: null, recipient_fp: null, draft_sha256: null, target: null, recipients_fp: null },
    approval_event: { task_id: "t-1", seq: 3 }, chain_head_at_approval: "sha256:" + "2".repeat(64),
    issued_at: "2026-01-01T09:00:00+09:00", execution_window: null, ...over,
  });

  it("signs the canonical token with HMAC-SHA256", () => {
    const t = mintToken(base(), { approval_key_hex: KEY });
    const { mac, ...rest } = t;
    expect(mac).toBe("hmac-sha256:" + hmacHex(KEY, jcs(rest)));
    expect(t["max_uses"]).toBe(1);
  });
  it("expiry: user outbound 24h, user money_out 30m, stage rule 5m", () => {
    expect(mintToken(base(), { approval_key_hex: KEY })["expires_at"]).toBe("2026-01-02T09:00:00+09:00");
    expect(mintToken(base({ action: "transfer.submit" }), { approval_key_hex: KEY })["expires_at"]).toBe("2026-01-01T09:30:00+09:00");
    const rule = base({ issued_by: "stage_rule", card_id: null, stage: 3, rule_id: "r1", command_ref: { kind: "standing_order", id: "o1" }, scope_sha256: "sha256:x" });
    expect(mintToken(rule, { approval_key_hex: KEY })["expires_at"]).toBe("2026-01-01T09:05:00+09:00");
  });
  it("rejects unknown actions and mixed user/rule fields", () => {
    expect(() => mintToken(base({ action: "file.delete" }), { approval_key_hex: KEY })).toThrow(/approval-required list/);
    expect(() => mintToken(base({ rule_id: "r1" }), { approval_key_hex: KEY })).toThrow(/user token/);
    expect(() => mintToken(base({ issued_by: "stage_rule" }), { approval_key_hex: KEY })).toThrow(/stage-rule token/);
  });
  it("refuses stage-rule tokens at stage 1 and keys shorter than 32 bytes", () => {
    const rule = base({ issued_by: "stage_rule", card_id: null, stage: 1, rule_id: "r1", command_ref: { kind: "standing_order", id: "o1" }, scope_sha256: "sha256:x" });
    expect(() => mintToken(rule, { approval_key_hex: KEY })).toThrow(/stage 1/);
    expect(() => mintToken(base(), { approval_key_hex: "ab" })).toThrow(/32 bytes/);
    expect(() => mintToken(base(), { approval_key_hex: "ab".repeat(31) })).toThrow(/32 bytes/);
  });
  it("verifyToken: MAC, expiry and task/plan/action binding", () => {
    const t = mintToken(base(), { approval_key_hex: KEY });
    const check = { approval_key_hex: KEY, now: new Date("2026-01-01T10:00:00+09:00"), task_id: "t-1", plan_sha256: base().plan_sha256, action: "message.send" };
    expect(verifyToken(t, check)).toEqual({ ok: true });
    expect(verifyToken({ ...t, action: "transfer.submit" }, { ...check, action: "transfer.submit" })).toEqual({ ok: false, reason: "bad_mac" });
    expect(verifyToken({ ...t, mac: "hmac-sha256:" + "0".repeat(64) }, check)).toEqual({ ok: false, reason: "bad_mac" });
    expect(verifyToken(t, { ...check, approval_key_hex: "cd".repeat(32) })).toEqual({ ok: false, reason: "bad_mac" });
    expect(verifyToken(t, { ...check, now: new Date("2026-01-02T09:00:00+09:00") })).toEqual({ ok: false, reason: "expired" });
    expect(verifyToken(t, { ...check, task_id: "t-2" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyToken(t, { ...check, action: "form.submit_outbound" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyToken({ ...t, mac: 1 }, check)).toEqual({ ok: false, reason: "malformed" });
    const w = mintToken(base({ execution_window: { start: "2026-01-01T20:00:00+09:00", end: "2026-01-02T02:00:00+09:00" } }), { approval_key_hex: KEY });
    expect(verifyToken(w, check)).toEqual({ ok: false, reason: "not_yet" });
    expect(verifyToken(w, { ...check, now: new Date("2026-01-01T21:00:00+09:00") })).toEqual({ ok: true });
  });
  it("verifyToken returns malformed (does not throw) for a non-integer number edited into the token", () => {
    const t = mintToken(base(), { approval_key_hex: KEY });
    const check = { approval_key_hex: KEY, now: new Date("2026-01-01T10:00:00+09:00"), task_id: "t-1", plan_sha256: base().plan_sha256, action: "message.send" };
    expect(verifyToken({ ...t, stage: 1.5 }, check)).toEqual({ ok: false, reason: "malformed" });
  });
  it("execution window: at most 12h long and starting within 24h", () => {
    const ok = base({ execution_window: { start: "2026-01-01T20:00:00+09:00", end: "2026-01-02T02:00:00+09:00" } });
    expect(mintToken(ok, { approval_key_hex: KEY })["expires_at"]).toBe("2026-01-02T02:00:00+09:00");
    const long = base({ execution_window: { start: "2026-01-01T10:00:00+09:00", end: "2026-01-02T10:00:00+09:00" } });
    expect(() => mintToken(long, { approval_key_hex: KEY })).toThrow(/execution window/);
  });
});

describe("canonical JSON", () => {
  it("sorts keys, drops undefined, normalizes -0 and rejects non-integers", () => {
    expect(jcs({ b: 1, a: [true, null, "x\n"], c: undefined, d: -0 })).toBe('{"a":[true,null,"x\\n"],"b":1,"d":0}');
    expect(() => jcs({ x: 1.5 })).toThrow(/integers only/);
  });
});
