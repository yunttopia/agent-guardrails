import type { BudgetKey, BudgetStore, LoopToolSpec, ModelRequest } from "../../src/model/types.ts";

export interface MemBudget extends BudgetStore {
  reserves: Array<{ keys: BudgetKey[]; estimateMkrw: number }>;
  settles: Array<{ id: string; actualMkrw: number }>;
  releases: string[];
}

export function memBudget(monthCapMkrw: number | null): MemBudget {
  const reserves: MemBudget["reserves"] = [];
  const settles: MemBudget["settles"] = [];
  const releases: string[] = [];
  let n = 0;
  let spent = 0;
  return {
    reserves, settles, releases,
    reserve(keys, estimateMkrw) {
      reserves.push({ keys, estimateMkrw });

      if (monthCapMkrw === null) return { ok: false, scope: "unset", period: null, capMkrw: null, spentMkrw: spent };
      if (spent + estimateMkrw > monthCapMkrw) return { ok: false, scope: "month", period: keys.find((k) => k.scope === "month")?.id ?? null, capMkrw: monthCapMkrw, spentMkrw: spent };
      return { ok: true, reservationId: `r${++n}` };
    },
    settle(id, actualMkrw) {
      settles.push({ id, actualMkrw });
      spent += actualMkrw;
    },
    release(id) {
      releases.push(id);
    },
    spent: () => ({ capMkrw: monthCapMkrw, spentMkrw: spent }),
  };
}

export function req(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: { provider: "fake", model: "fake-1", effort: null },
    system: "You are an assistant.",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    taskId: "t1",
    attemptId: "a1",
    maxOutputTokens: 1000,
    purpose: "worker_turn",
    mode: "balanced",
    ...over,
  };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export function toolSpec(name: string, argsSchema: Record<string, unknown> = { type: "object" }): LoopToolSpec {
  return { name, description: `${name} test tool`, argsSchema, effect: "read", risk: "none", network: false };
}
