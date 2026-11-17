// Canonical JSON and event hashing for the event log.
import { createHash } from "node:crypto";

export class CanonicalError extends Error {}

export function normalizeForStore(v: unknown, path = "$"): unknown {
  if (typeof v === "string") return v.normalize("NFC");
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new CanonicalError(`${path}: non-integer number`);
    return v;
  }
  if (v === null || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x, i) => normalizeForStore(x, `${path}[${i}]`));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined) continue;
      out[k.normalize("NFC")] = normalizeForStore(x, `${path}.${k}`);
    }
    return out;
  }
  throw new CanonicalError(`${path}: value cannot be logged (${typeof v})`);
}

function cmpCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new CanonicalError("non-integer number");
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(cmpCodePoint);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new CanonicalError(`value cannot be canonicalized (${typeof v})`);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export const ZERO_HASH = `sha256:${"0".repeat(64)}`;

export function eventHash(event: Record<string, unknown>): string {
  const { hash: _drop, ...rest } = event;
  return `sha256:${sha256Hex(canonicalJson(rest))}`;
}
