// Small helpers for the gate: typed input errors, RFC 8785 (JCS) canonical JSON, HMAC and KST time formatting.
import { createHmac, timingSafeEqual } from "node:crypto";

export type Obj = Record<string, unknown>;

export class InputInvalid extends Error {
  declare readonly code: "missing" | "type" | "invalid";
  declare readonly offending: { v: unknown } | null;
  constructor(msg: string, code: "missing" | "type" | "invalid" = "invalid", offending: { v: unknown } | null = null) {
    super(msg);
    Object.defineProperty(this, "code", { value: code, enumerable: false, writable: false, configurable: false });
    Object.defineProperty(this, "offending", { value: offending, enumerable: false, writable: false, configurable: false });
  }
}

export function fail(msg: string, code: "missing" | "type" | "invalid" = "invalid", ...value: [unknown?]): never {
  throw new InputInvalid(msg, code, value.length > 0 ? { v: value[0] } : null);
}
const shapeCode = (v: unknown) => (v === undefined ? "missing" : "type");

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown, what: string): string {
  if (typeof v !== "string") fail(`${what}: not a string`, shapeCode(v), v);
  return v;
}

function jcsString(s: string): string {
  let out = "\"";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\"") out += "\\\"";
    else if (ch === "\\") out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + "\"";
}

export function jcs(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) fail("JCS: integers only");
    return String(Object.is(v, -0) ? 0 : v);
  }
  if (typeof v === "string") return jcsString(v);
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  if (isObj(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + keys.map((k) => jcsString(k) + ":" + jcs(v[k])).join(",") + "}";
  }
  fail("JCS: unsupported value");
}

export function hmacHex(keyHex: string, msg: string): string {
  if (!/^([0-9a-f]{2})+$/.test(keyHex)) fail("key is not hex");
  if (keyHex.length < 64) fail("key must be at least 32 bytes");
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(Buffer.from(msg, "utf8")).digest("hex");
}

export function toMillis(s: unknown, what: string): number {
  const t = str(s, what);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(t)) fail(`${what}: not RFC 3339`);
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) fail(`${what}: cannot parse time`);
  return ms;
}

const KST = 9 * 3600 * 1000;

export function kstParts(ms: number): { y: number; m: number; d: number; H: number; M: number; S: number } {
  const d = new Date(ms + KST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds() };
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8"), y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
