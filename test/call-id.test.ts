import { describe, expect, it } from "vitest";
import { nextCallId } from "../src/log/call-id.ts";
import type { LoggedEvent } from "../src/types.ts";

const ev = (type: string, call_id?: string) => ({ type, seq: 1, ...(call_id ? { call_id } : {}) }) as unknown as LoggedEvent;
describe("nextCallId", () => {
  it("empty log gives c1; sequential ids give count+1 == max+1", () => {
    expect(nextCallId([])).toBe("c1");
    expect(nextCallId([ev("tool_call", "c1"), ev("tool_result", "c1"), ev("tool_call", "c2")])).toBe("c3");
  });
  it("with a gap (c1, c3) the next id is max+1 (c4), not count+1 (c3)", () => {
    expect(nextCallId([ev("tool_call", "c1"), ev("tool_call", "c3")])).toBe("c4");
  });
  it("also avoids ids seen only on result events (c5); non-c ids only count", () => {
    expect(nextCallId([ev("tool_call", "c1"), ev("check", "c5")])).toBe("c6");
    expect(nextCallId([ev("tool_call", "fake_call_1"), ev("tool_call", "fake_call_2")])).toBe("c3");
  });
});
