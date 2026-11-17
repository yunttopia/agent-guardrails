// Detects duplicate step ids in a plan (ambiguous references to a step).
import type { Obj } from "./common.ts";

export const DUPLICATE_STEP_ID = "DUPLICATE_STEP_ID";

export function duplicateStepIds(plan: Obj): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  const items = Array.isArray(plan["items"]) ? (plan["items"] as unknown[]) : [];
  for (const it of items) {
    const steps = it !== null && typeof it === "object" && Array.isArray((it as Obj)["steps"]) ? ((it as Obj)["steps"] as unknown[]) : [];
    for (const s of steps) {
      const id = s !== null && typeof s === "object" ? (s as Obj)["step_id"] : undefined;
      if (typeof id !== "string") continue;
      if (seen.has(id)) { if (!dup.includes(id)) dup.push(id); } else seen.add(id);
    }
  }
  return dup;
}

export function planHasDuplicateStepId(plan: Obj): boolean {
  return duplicateStepIds(plan).length > 0;
}
