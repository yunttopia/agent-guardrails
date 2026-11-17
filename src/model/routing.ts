// Routing: task kind + usage mode -> provider, model and effort, with fallback caps.
import type { Effort, ModelRef, UsageMode } from "./types.ts";

export type Slot = "best" | "value" | "backup";
export interface SlotEntry { model: string; provider: string; effort: Effort }
export interface TaskKindEntry {
  active: "best" | "value" | null;
  best: SlotEntry;
  value: SlotEntry;
  backup: SlotEntry;
  source: string;
  renamed_from?: string;
}
export interface ModePreset {
  active: "best" | "value";
  effortCap: Effort | null;
  overrides: Record<string, { active?: "best" | "value"; effortCap?: Effort | null }>;
  concurrency: number;
}
export interface RoutingFile {
  version: string;
  enabledProviders: string[];
  fallback: { retrySameModel: number; autoSwitchOnlyBeforeFirstOutput: boolean; onRefusal: "ask_user"; onUnknownPrice: "not_routable" | "allow" };
  modes: {
    default: UsageMode;
    effortOrder: Effort[];
    providerDefaultCompareAs: Effort;
    presets: Record<UsageMode, ModePreset>;
    displayNames: Record<UsageMode, string>;
  };
  taskKinds: Record<string, TaskKindEntry>;
}

export interface PickContext {
  excluded?: ReadonlySet<string>;

  excludedProviders?: ReadonlySet<string>;
  isPriceKnown: (provider: string, model: string) => boolean;
}

export type PickResult =
  | { ok: true; ref: ModelRef & { effort: Effort }; slot: Slot; routingVersion: string; mode: UsageMode; candidatesSkipped: Array<{ slot: Slot; why: "provider_disabled" | "excluded" | "price_unknown" }> }
  | { ok: false; reason: "unknown_kind" | "no_candidate"; routingVersion: string };

const EFFORTS: readonly Effort[] = ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function parseRoutingFile(raw: unknown): RoutingFile {
  const r = raw as RoutingFile;
  if (typeof r?.version !== "string" || !Array.isArray(r.enabledProviders) || typeof r.taskKinds !== "object" || typeof r.modes?.presets !== "object") {
    throw new Error("routing: version/enabledProviders/taskKinds/modes");
  }
  for (const [kind, e] of Object.entries(r.taskKinds)) {
    for (const s of ["best", "value", "backup"] as const) {
      const slot = e[s];
      if (!slot || typeof slot.model !== "string" || typeof slot.provider !== "string" || !EFFORTS.includes(slot.effort)) {
        throw new Error(`routing: ${kind}.${s}`);
      }
    }
  }
  for (const m of ["high", "balanced", "saver"] as const) {
    if (!r.modes.presets[m]) throw new Error(`routing: modes.presets.${m}`);
  }
  return r;
}

export function capEffort(slot: Effort, cap: Effort | null, order: Effort[], providerDefaultAs: Effort): Effort {
  if (cap === null) return slot;
  const rank = (e: Effort) => order.indexOf(e === "provider-default" ? providerDefaultAs : e);
  return rank(cap) < rank(slot) ? cap : slot;
}

export function pick(routing: RoutingFile, kind: string, mode: UsageMode, ctx: PickContext): PickResult {
  const e = routing.taskKinds[kind];
  if (!e) return { ok: false, reason: "unknown_kind", routingVersion: routing.version };
  const preset = routing.modes.presets[mode];
  const override = preset.overrides[kind];
  const active: "best" | "value" = e.active ?? override?.active ?? preset.active;
  const cap = override && "effortCap" in override ? (override.effortCap ?? null) : preset.effortCap;
  const order: Slot[] = [active, "backup", active === "best" ? "value" : "best"];
  const skipped: Array<{ slot: Slot; why: "provider_disabled" | "excluded" | "price_unknown" }> = [];
  for (const slot of order) {
    const c = e[slot];
    if (!routing.enabledProviders.includes(c.provider) || ctx.excludedProviders?.has(c.provider)) {
      skipped.push({ slot, why: "provider_disabled" });
      continue;
    }
    if (ctx.excluded?.has(`${c.provider}/${c.model}`)) {
      skipped.push({ slot, why: "excluded" });
      continue;
    }
    if (routing.fallback.onUnknownPrice === "not_routable" && !ctx.isPriceKnown(c.provider, c.model)) {
      skipped.push({ slot, why: "price_unknown" });
      continue;
    }
    let effort = capEffort(c.effort, cap, routing.modes.effortOrder, routing.modes.providerDefaultCompareAs);

    if (slot !== active) effort = capEffort(effort, e[active].effort, routing.modes.effortOrder, routing.modes.providerDefaultCompareAs);
    return { ok: true, ref: { provider: c.provider, model: c.model, effort }, slot, routingVersion: routing.version, mode, candidatesSkipped: skipped };
  }
  return { ok: false, reason: "no_candidate", routingVersion: routing.version };
}

export function toOffline(ref: ModelRef): ModelRef & { routedFrom: ModelRef } {
  return { provider: "fake", model: "fake-1", effort: ref.effort, routedFrom: ref };
}

export function pickOffline(routing: RoutingFile, kind: string, mode: UsageMode, ctx: Omit<PickContext, "isPriceKnown">): PickResult & { routedFrom?: ModelRef } {
  const r = pick(routing, kind, mode, { ...ctx, isPriceKnown: () => true });
  if (!r.ok) return r;
  const off = toOffline(r.ref);
  return { ...r, ref: { provider: off.provider, model: off.model, effort: r.ref.effort }, routedFrom: off.routedFrom };
}

export const PURPOSE_ROUTING_KIND = {
  draft_write: "conversation and drafting",
  study_sheet: "structured extraction",
  minutes_extract: "structured extraction",
  register_rewrite: "conversation and drafting",
} as const satisfies Partial<Record<import("./types.ts").ModelPurpose, string>>;
