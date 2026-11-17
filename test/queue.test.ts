import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DbKeyError, openCoreDb, openMemoryDb, openUnencryptedDevDb, SCHEMA_VERSION, readSchemaVersion } from "../src/db.ts";
import { LogWriter } from "../src/log/writer.ts";
import { ApprovalStore } from "../src/queue/approvals.ts";
import { SqliteBudgetStore } from "../src/queue/budget.ts";
import { StepJournal } from "../src/queue/steps.ts";
import { TaskStore, TransitionError } from "../src/queue/store.ts";
import type { NewTask } from "../src/types.ts";
import { mintToken, type IssueRequest } from "../src/gate/mint-token.ts";
import { ZERO_HASH } from "../src/util/jcs.ts";

const T0 = new Date("2026-01-05T10:00:00+09:00");
const tmp = () => mkdtempSync(join(tmpdir(), "ag-test-"));
const clock = () => T0;
const task = (over: Partial<NewTask> = {}): NewTask => ({
  title: "demo", planId: "p1", planSha256: "sha256:" + "0".repeat(64), kind: "task", origin: { kind: "background" }, usesBrowser: false,
  model: { provider: "fake", model: "fake-1", effort: null }, ...over,
});
function setup() {
  const db = openMemoryDb();
  const log = new LogWriter(tmp(), clock);
  return { db, log, store: new TaskStore(db, log, clock) };
}

describe("db", () => {
  it("creates a fresh schema at the current version", () => {
    expect(readSchemaVersion(openMemoryDb().sql)).toBe(SCHEMA_VERSION);
  });
  it("encrypted file: reopens with the same key, refuses a different key", () => {
    const p = join(tmp(), "a.db");
    openCoreDb(p, new Uint8Array(32).fill(1)).sql.close();
    expect(() => openCoreDb(p, new Uint8Array(32).fill(2))).toThrow(DbKeyError);
    openCoreDb(p, new Uint8Array(32).fill(1)).sql.close();
    expect(readFileSync(p).subarray(0, 16).toString("latin1")).not.toContain("SQLite format");
  });
  it("unencrypted DB only under the temp dir", () => {
    expect(() => openUnencryptedDevDb(join(homedir(), "not-allowed.db"))).toThrow(/temp dir/);
    expect(openUnencryptedDevDb(join(tmp(), "dev.db")).unencryptedForDev).toBe(true);
  });
});

describe("event log", () => {
  it("chains each event to the previous hash", () => {
    const log = new LogWriter(tmp(), clock);
    const a = log.append("t-1", { type: "note", text: "one" });
    const b = log.append("t-1", { type: "note", text: "two" });
    const evs = log.events("t-1");
    expect(evs.map((e) => e.seq)).toEqual([1, 2]);
    expect(evs[0]!.prev_hash).toBe(ZERO_HASH);
    expect(evs[1]!.prev_hash).toBe(a.hash);
    expect(log.head("t-1")).toEqual({ seq: 2, hash: b.hash });
  });
  it("cuts a torn last line on reopen and refuses corruption in the middle", () => {
    const root = tmp();
    const log = new LogWriter(root, clock);
    log.append("t-1", { type: "note" });
    appendFileSync(log.logPath("t-1"), '{"half":');
    const again = new LogWriter(root, clock);
    expect(again.events("t-1")).toHaveLength(1);
    expect(again.torn).toEqual([{ taskId: "t-1", tornBytes: 8 }]);
    appendFileSync(again.logPath("t-1"), "not json\n" + JSON.stringify({ seq: 9 }) + "\n");
    expect(() => new LogWriter(root, clock).events("t-1")).toThrow(/corrupt/);
  });
});

describe("task store", () => {
  it("claims by priority, takes a lease and logs the transition", () => {
    const { store, log } = setup();
    store.create("t-a", task({ priority: 200 }));
    store.create("t-b", task({ priority: 50 }));
    const c = store.claimNext(T0, 60_000, { maxRunning: 2, maxBrowser: 1 });
    expect(c?.id).toBe("t-b");
    expect(c?.leaseToken).toBeTruthy();
    expect(log.events("app").at(-1)).toMatchObject({ app_kind: "ops.task_state", subject: "t-b", data: { from: "planned", to: "running" } });
  });
  it("respects maxRunning, not-before and the single browser slot", () => {
    const { store } = setup();
    store.create("t-a", task({ usesBrowser: true }));
    store.create("t-b", task({ usesBrowser: true }));
    store.create("t-c", task({ notBefore: "2026-01-05T11:00:00+09:00" }));
    const lim = { maxRunning: 3, maxBrowser: 1 } as const;
    expect(store.claimNext(T0, 60_000, lim)?.id).toBe("t-a");
    expect(store.claimNext(T0, 60_000, lim)).toBeNull();
    expect(store.claimNext(new Date("2026-01-05T11:00:00+09:00"), 60_000, lim)?.id).toBe("t-c");
  });
  it("rejects transitions outside the state machine and stale leases", () => {
    const { store } = setup();
    store.create("t-a", task());
    const c = store.claimNext(T0, 60_000, { maxRunning: 1, maxBrowser: 1 })!;
    expect(store.transition("t-a", "wrong-lease", "done", null)).toBe(false);
    expect(store.transition("t-a", c.leaseToken!, "done", null)).toBe(true);
    expect(() => store.transition("t-a", null, "running", null)).toThrow(TransitionError);
  });
  it("observe tasks never take a run slot", () => {
    const { store } = setup();
    store.create("obs-1", task({ kind: "observe" }));
    expect(store.claimNext(T0, 60_000, { maxRunning: 1, maxBrowser: 1 })).toBeNull();
  });
});

describe("step journal", () => {
  const start = { taskId: "t-1", callId: "c1", stepRef: null, caseId: null, toolName: "message.send", argsHash: "h", risk: "outbound", effect: "external_irreversible", idempotencyKey: "k", approvalTokenId: null, callSeq: 1 } as const;
  it("start -> committed / unknown -> reconciled", () => {
    const steps = new StepJournal(openMemoryDb());
    steps.start(start, "t0");
    steps.finish("t-1", "c1", "unknown", 2, null, "t1");
    expect(steps.unresolved("t-1").map((s) => s.callId)).toEqual(["c1"]);
    steps.reconciled("t-1", "c1", "ok", 3, "t2");
    expect(steps.committed("t-1")[0]).toMatchObject({ state: "committed", reconcileSeq: 3 });
  });
  it("rebuilds from the event log after a crash", () => {
    const log = new LogWriter(tmp(), clock);
    log.append("t-1", { type: "tool_call", call_id: "c1", tool: "a", risk: "none" });
    log.append("t-1", { type: "tool_result", call_id: "c1", status: "ok" });
    log.append("t-1", { type: "tool_call", call_id: "c2", tool: "b", risk: "outbound" });
    const steps = new StepJournal(openMemoryDb());
    const r = steps.rebuild("t-1", log);
    expect(r.interrupted).toEqual(["c2"]);
    expect(steps.get("t-1", "c1")).toMatchObject({ state: "committed", origin: "rebuilt" });
    expect(steps.open("t-1").map((s) => s.callId)).toEqual(["c2"]);
  });
});

describe("budget store", () => {
  const day = { scope: "day", id: "2026-01-05" } as const;
  const month = { scope: "month", id: "2026-01" } as const;
  it("refuses when no cap is set", () => {
    expect(new SqliteBudgetStore(openMemoryDb()).reserve([day, month], 10, "t")).toMatchObject({ ok: false, scope: "unset" });
  });
  it("counts reserved estimates and settled actuals against the cap", () => {
    const b = new SqliteBudgetStore(openMemoryDb());
    b.setCap({ scope: "day", id: "default" }, 100);
    b.setCap({ scope: "month", id: "default" }, 150);
    const r1 = b.reserve([day, month], 80, "t");
    if (!r1.ok) throw new Error("expected ok");
    expect(b.reserve([day, month], 30, "t")).toMatchObject({ ok: false, scope: "day", period: "2026-01-05", spentMkrw: 80 });
    b.settle(r1.reservationId, 20, "t");
    expect(b.spent(month).spentMkrw).toBe(20);
    const r2 = b.reserve([day, month], 70, "t");
    if (!r2.ok) throw new Error("expected ok");
    b.release(r2.reservationId);
    expect(b.spent(day).spentMkrw).toBe(20);
    expect(() => b.settle(r2.reservationId, 1, "t")).toThrow(/no open reservation/);
  });
});

describe("approval store", () => {
  const KEY = "ab".repeat(32);
  const req = (id: string): IssueRequest => ({
    token_id: id, task_id: "t-1", case_id: null, action: "message.send", plan_sha256: "sha256:" + "1".repeat(64),
    issued_by: "user", card_id: "card-1", stage: 1, rule_id: null, command_ref: null, scope_sha256: null,
    bind: { amount: null, account_fp: null, recipient_fp: null, draft_sha256: null, target: null, recipients_fp: null },
    approval_event: { task_id: "t-1", seq: 3 }, chain_head_at_approval: "sha256:" + "2".repeat(64),
    issued_at: "2026-01-01T09:00:00+09:00", execution_window: null,
  });
  const check = { approval_key_hex: KEY, now: new Date("2026-01-01T10:00:00+09:00"), task_id: "t-1", plan_sha256: "sha256:" + "1".repeat(64), action: "message.send" };
  const stored = (id: string, edit: (t: Record<string, unknown>) => Record<string, unknown> = (t) => t) => {
    const a = new ApprovalStore(openMemoryDb());
    a.save(req(id), edit(mintToken(req(id), { approval_key_hex: KEY })), "t");
    return a;
  };

  it("consumes a valid token exactly once (max_uses 1)", () => {
    const a = stored("x");
    expect(a.consume("x", check)).toEqual({ ok: true });
    expect(a.consume("x", check)).toEqual({ ok: false, reason: "used_up" });
    expect(a.usedTimes("x")).toBe(1);
  });
  it("refuses a token edited after signing (changed action, zeroed MAC)", () => {
    const a = stored("x", (t) => ({ ...t, action: "transfer.submit", mac: "hmac-sha256:" + "0".repeat(64) }));
    expect(a.consume("x", { ...check, action: "transfer.submit" })).toEqual({ ok: false, reason: "bad_mac" });
    expect(a.usedTimes("x")).toBe(0);
  });
  it("refuses an expired token", () => {
    const a = stored("x");
    expect(a.consume("x", { ...check, now: new Date("2026-01-03T00:00:00+09:00") })).toEqual({ ok: false, reason: "expired" });
    expect(a.usedTimes("x")).toBe(0);
  });
  it("refuses after revoke, and revokeOpenFor revokes only unused tokens", () => {
    const a = stored("x");
    a.save(req("y"), mintToken(req("y"), { approval_key_hex: KEY }), "t");
    expect(a.consume("x", check)).toEqual({ ok: true });
    expect(a.revokeOpenFor("t-1", "t2")).toEqual(["y"]);
    expect(a.consume("y", check)).toEqual({ ok: false, reason: "revoked" });
    expect(a.revoke("x", "t3")).toBe(1);
    expect(a.consume("x", check)).toEqual({ ok: false, reason: "revoked" });
    expect(a.consume("nope", check)).toEqual({ ok: false, reason: "not_found" });
    expect(() => a.save(req("z"), { token_id: "other" }, "t")).toThrow(/differs/);
  });
});
