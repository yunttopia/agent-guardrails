// Risk ranks and the check that a plan step never declares less risk than its tool.
import type { Obj } from "./common.ts";
import type { Risk } from "./types.ts";

export const STEP_RISK_RANK: Readonly<Record<Risk, number>> = { none: 0, irreversible: 1, outbound: 2, money_out: 3 };

export function riskUnderstated(stepRisk: unknown, toolRisk: unknown): boolean {
  const t = STEP_RISK_RANK[toolRisk as Risk] ?? 3;
  const s = STEP_RISK_RANK[stepRisk as Risk] ?? -1;
  return t > s;
}

export function planHasUnderstatedStep(plan: Obj, toolRisks: Readonly<Record<string, Risk>>): boolean {
  const items = Array.isArray(plan["items"]) ? (plan["items"] as unknown[]) : [];
  for (const it of items) {
    const steps = it !== null && typeof it === "object" && Array.isArray((it as Obj)["steps"]) ? ((it as Obj)["steps"] as unknown[]) : [];
    for (const s of steps) {
      if (s === null || typeof s !== "object") continue;
      const tool = (s as Obj)["tool"];
      // Unknown or missing tools count as the highest risk (closed default).
      const known = typeof tool === "string" && Object.prototype.hasOwnProperty.call(toolRisks, tool);
      if (riskUnderstated((s as Obj)["risk"], known ? toolRisks[tool as string] : undefined)) return true;
    }
  }
  return false;
}

export const STEP_RISK_UNDERSTATED = "STEP_RISK_UNDERSTATED";
