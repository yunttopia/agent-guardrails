// Next tool-call id for a task: max seen + 1, so ids are never reused.
import type { LoggedEvent } from "../types.ts";

export function nextCallId(events: readonly LoggedEvent[]): string {
  let max = 0, calls = 0;
  for (const e of events) {
    if (e.type === "tool_call") calls++;
    const m = /^c(\d+)$/u.exec(String(e["call_id"] ?? ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${Math.max(max, calls) + 1}`;
}
