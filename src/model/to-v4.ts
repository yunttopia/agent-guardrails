// Converts our request/messages to AI SDK v4 call options (cache breakpoints, reasoning replay).
import { createHash } from "node:crypto";
import type { LanguageModelV4CallOptions, LanguageModelV4FunctionTool, LanguageModelV4Message } from "@ai-sdk/provider";
import type { LoopToolSpec, ModelRequest, OpaqueReasoning } from "./types.ts";

export const DROP_AWAITING_TURN_THINKING = false;

export const DROP_AFTER_FIRST_MISMATCH = true;

export const SAFETY_NET_MODELS: ReadonlySet<string> = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

export const OPENAI_STORE = false;

export interface ToV4Options {
  replayThinking?: boolean;

  safetyNet?: boolean;

  dropAwaitingTurnThinking?: boolean;

  dropAfterFirstMismatch?: boolean;

  replayOpenaiReasoning?: boolean;
}

export interface ToV4Result {
  options: Omit<LanguageModelV4CallOptions, "abortSignal">;
  toolsHash: string;
  droppedReasoning: number;

  droppedPrefix: number;

  carriedThinking: number;

  droppedUnencrypted: number;

  carriedOpenaiReasoning: number;

  safetyNet: boolean;

  keptMismatchedAwaiting: boolean;

  prefixHash: string;

  toolNames: ToolNameTable;

  nameError: string | null;
}

export const WIRE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolNameTable {
  toWire: ReadonlyMap<string, string>;
  fromWire: ReadonlyMap<string, string>;
}

export type ToolNameTableResult =
  | { ok: true; table: ToolNameTable }
  | { ok: false; code: "tool_name_collision" | "tool_name_invalid"; names: string[] };

export function buildToolNameTable(names: readonly string[], opts: { encode: boolean } = { encode: true }): ToolNameTableResult {
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  for (const name of [...names].sort()) {
    const wire = opts.encode ? name.replace(/[^a-zA-Z0-9_-]/g, "_") : name;
    if (opts.encode && !WIRE_TOOL_NAME.test(wire)) return { ok: false, code: "tool_name_invalid", names: [name] };
    const prev = fromWire.get(wire);
    if (prev !== undefined) return { ok: false, code: "tool_name_collision", names: [prev, name] };
    toWire.set(name, wire);
    fromWire.set(wire, name);
  }
  return { ok: true, table: { toWire, fromWire } };
}

type JsonObj = Record<string, unknown>;

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as JsonObj;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function sha16(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

export function toV4Tools(tools: Array<Pick<LoopToolSpec, "name" | "description" | "argsSchema">>, table?: ToolNameTable): { tools: LanguageModelV4FunctionTool[]; toolsHash: string } {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: LanguageModelV4FunctionTool[] = sorted.map((t) => ({
    type: "function",
    name: table?.toWire.get(t.name) ?? t.name,
    description: t.description,
    inputSchema: t.argsSchema as LanguageModelV4FunctionTool["inputSchema"],
  }));
  return { tools: out, toolsHash: sha16(canonicalJson(out)) };
}

function sameOrigin(o: OpaqueReasoning | undefined, req: ModelRequest): boolean {
  return o !== undefined && o.origin.provider === req.model.provider && o.origin.model === req.model.model;
}

function openaiMeta(o: OpaqueReasoning): { itemId: string | null; encrypted: boolean } {
  const m = o.providerMetadata["openai"];
  if (m === null || typeof m !== "object") return { itemId: null, encrypted: false };
  const { itemId, reasoningEncryptedContent } = m as JsonObj;
  return { itemId: typeof itemId === "string" ? itemId : null, encrypted: typeof reasoningEncryptedContent === "string" && reasoningEncryptedContent !== "" };
}

const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

export function stripCacheControl(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCacheControl);
  if (v === null || typeof v !== "object") return v;
  const out: JsonObj = {};
  for (const [k, x] of Object.entries(v as JsonObj)) {
    if (k === "providerOptions" && x !== null && typeof x === "object") {
      const po: JsonObj = {};
      for (const [pk, pv] of Object.entries(x as JsonObj)) {
        if (pk === "anthropic" && pv !== null && typeof pv === "object") {
          const { cacheControl: _drop, ...rest } = pv as JsonObj;
          if (Object.keys(rest).length > 0) po[pk] = stripCacheControl(rest);
        } else po[pk] = stripCacheControl(pv);
      }
      if (Object.keys(po).length > 0) out[k] = po;
      continue;
    }
    out[k] = stripCacheControl(x);
  }
  return out;
}

export function prefixHashOf(system: string, toolsHash: string, chain: string): string {
  return sha16(canonicalJson({ s: system, t: toolsHash, m: chain }));
}
export function chainNext(chain: string, msg: LanguageModelV4Message): string {
  return sha16(`${chain}\n${canonicalJson(stripCacheControl(msg))}`);
}

function adaptiveEffort(effort: string | null): boolean {
  return effort !== null && effort !== "provider-default" && effort !== "none";
}

export function toV4(req: ModelRequest, opts: ToV4Options = {}): ToV4Result {
  const replayThinking = opts.replayThinking ?? true;
  const dropAwaiting = opts.dropAwaitingTurnThinking ?? DROP_AWAITING_TURN_THINKING;
  const dropAfterFirst = opts.dropAfterFirstMismatch ?? DROP_AFTER_FIRST_MISMATCH;
  let droppedReasoning = 0;
  let droppedPrefix = 0;
  let carriedThinking = 0;
  let droppedUnencrypted = 0;
  let carriedOpenaiReasoning = 0;
  const replayOpenai = opts.replayOpenaiReasoning ?? true;
  let keptMismatchedAwaiting = false;
  const toolNames = new Map<string, string>();
  const built = buildToolNameTable(req.tools.map((t) => t.name), { encode: req.model.provider !== "fake" });
  const table: ToolNameTable = built.ok ? built.table : { toWire: new Map(), fromWire: new Map() };
  let nameError: string | null = built.ok ? null : built.code;

  const wire = (name: string): string => {
    const w = table.toWire.get(name);
    if (w !== undefined) return w;
    nameError ??= "tool_name_not_in_list";
    return name;
  };
  const prompt: LanguageModelV4Message[] = [];
  const anthropic = req.model.provider === "anthropic";
  const openai = req.model.provider === "openai";
  const { tools, toolsHash } = toV4Tools(req.tools, table);

  prompt.push(anthropic ? { role: "system", content: req.system, providerOptions: ANTHROPIC_CACHE } : { role: "system", content: req.system });

  let lastAssistant = -1;
  for (let i = req.messages.length - 1; i >= 0; i--) if (req.messages[i]?.role === "assistant") { lastAssistant = i; break; }
  const awaitingIdx = lastAssistant >= 0 && lastAssistant < req.messages.length - 1 && req.messages.slice(lastAssistant + 1).every((x) => x.role === "tool") ? lastAssistant : -1;

  let chain = "";

  let dropRest = false;

  for (const [mi, m] of req.messages.entries()) {
    const before = prompt.length;
    switch (m.role) {
      case "user":
      case "steering":
        prompt.push({ role: "user", content: [{ type: "text", text: m.content }] });
        break;
      case "assistant": {
        const content: Extract<LanguageModelV4Message, { role: "assistant" }>["content"] = [];
        if (m.parts && m.parts.length > 0) {
          const here = anthropic ? prefixHashOf(req.system, toolsHash, chain) : "";
          const awaiting = mi === awaitingIdx;

          const encryptedIds = new Set<string>();
          if (openai) for (const p of m.parts) if (p.kind === "thinking" && sameOrigin(p.opaque, req)) { const o = openaiMeta(p.opaque); if (o.encrypted && o.itemId !== null) encryptedIds.add(o.itemId); }
          for (const p of m.parts) {
            if (p.kind === "text") content.push({ type: "text", text: p.text });
            else if (p.kind === "thinking") {
              if (!sameOrigin(p.opaque, req)) {
                droppedReasoning++;
              } else if (openai) {
                const o = openaiMeta(p.opaque);
                if (!replayOpenai) {
                } else if (o.encrypted || (o.itemId !== null && encryptedIds.has(o.itemId))) {
                  content.push({ type: "reasoning", text: p.text, providerOptions: p.opaque.providerMetadata as never });
                  carriedOpenaiReasoning++;
                } else droppedUnencrypted++;
              } else if (!anthropic) {
                content.push({ type: "reasoning", text: p.text, providerOptions: p.opaque.providerMetadata as never });
              } else if (!replayThinking) {
              } else {
                const match = !(dropAfterFirst && dropRest) && p.opaque.boundPrefix !== undefined && p.opaque.boundPrefix === here;
                if (match) {
                  content.push({ type: "reasoning", text: p.text, providerOptions: p.opaque.providerMetadata as never });
                  carriedThinking++;
                } else if (awaiting && !dropAwaiting) {
                  content.push({ type: "reasoning", text: p.text, providerOptions: p.opaque.providerMetadata as never });
                  carriedThinking++;
                  keptMismatchedAwaiting = true;
                  dropRest = true;
                } else {
                  dropRest = true;
                  droppedPrefix++;
                }
              }
            } else {
              toolNames.set(p.call.id, wire(p.call.name));
              const keep = sameOrigin(p.opaque, req);
              if (p.opaque && !keep) droppedReasoning++;
              content.push({ type: "tool-call", toolCallId: p.call.id, toolName: wire(p.call.name), input: p.call.args, ...(keep && p.opaque ? { providerOptions: p.opaque.providerMetadata as never } : {}) });
            }
          }
        } else {
          if (m.content !== "") content.push({ type: "text", text: m.content });
          for (const c of m.toolCalls ?? []) {
            toolNames.set(c.id, wire(c.name));
            content.push({ type: "tool-call", toolCallId: c.id, toolName: wire(c.name), input: c.args });
          }
        }
        prompt.push({ role: "assistant", content });
        break;
      }
      case "tool":
        prompt.push({
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: m.callId,
            toolName: toolNames.get(m.callId) ?? "unknown",
            output: m.isError ? { type: "error-text", value: m.content } : { type: "text", value: m.content },
          }],
        });
        break;
    }
    if (anthropic) for (let k = before; k < prompt.length; k++) chain = chainNext(chain, prompt[k]!);
  }

  const prefixHash = anthropic ? prefixHashOf(req.system, toolsHash, chain) : "";

  if (anthropic) {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const p = prompt[i];
      if (p && p.role === "user") {
        prompt[i] = { ...p, providerOptions: ANTHROPIC_CACHE };
        break;
      }
    }
  }

  const effort = req.model.effort;

  const safetyNet = anthropic && (opts.safetyNet ?? true) && replayThinking && carriedThinking > 0 && adaptiveEffort(effort) && SAFETY_NET_MODELS.has(req.model.model);
  const options: ToV4Result["options"] = {
    prompt,
    maxOutputTokens: req.maxOutputTokens,
    ...(tools.length > 0 ? { tools } : {}),
    ...(effort !== null && effort !== "provider-default" ? { reasoning: effort as NonNullable<LanguageModelV4CallOptions["reasoning"]> } : {}),
    ...(safetyNet ? { providerOptions: { anthropic: { thinking: { type: "adaptive", display: "summarized", blockBinding: { prefixMismatchBehavior: "drop_block" } } } } } : {}),
    ...(openai ? { providerOptions: { openai: { store: OPENAI_STORE } } } : {}),
  };
  return { options, toolsHash, droppedReasoning, droppedPrefix, carriedThinking, droppedUnencrypted, carriedOpenaiReasoning, safetyNet, keptMismatchedAwaiting, prefixHash, toolNames: table, nameError };
}

export function estimateInputTokens(options: ToV4Result["options"]): number {
  return canonicalJson(options.prompt).length + canonicalJson(options.tools ?? []).length;
}
