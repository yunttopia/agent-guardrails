// fetch with host allowlist, https only, fixed User-Agent, header allowlist and minimal logging.
export const AGENT_VERSION = "0.1.0";
export const DEFAULT_USER_AGENT = `agent-guardrails/${AGENT_VERSION}`;
const MAX_REDIRECTS = 3;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ExchangeRecord {
  name: string;
  host: string;
  method: string;
  status: number | null;
  reqBytes: number | null;
  resBytes: number | null;
  error?: string;
}

export interface GuardPolicy {
  name: string;

  allowedHosts: string[];

  allowedHeaderNames: string[];
  userAgent?: string;
  fetchImpl?: FetchLike;
  onExchange?: (e: ExchangeRecord) => void;
}

export type GuardedFetchErrorCode = "host_not_allowed" | "scheme_not_allowed" | "bad_input" | "too_many_redirects";

export class GuardedFetchError extends Error {
  readonly code: GuardedFetchErrorCode;
  readonly host: string | null;
  constructor(code: GuardedFetchErrorCode, host: string | null) {
    super(`guardedFetch ${code}${host ? ` (${host})` : ""}`);
    this.name = "GuardedFetchError";
    this.code = code;
    this.host = host;
  }
}

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.$/, "");
}

function checkUrl(u: URL, allowed: ReadonlySet<string>): string {
  const host = hostOf(u);
  if (u.protocol !== "https:") throw new GuardedFetchError("scheme_not_allowed", host);
  if (u.username !== "" || u.password !== "") throw new GuardedFetchError("bad_input", host);
  if (u.port !== "" && u.port !== "443") throw new GuardedFetchError("host_not_allowed", host);
  if (!allowed.has(host)) throw new GuardedFetchError("host_not_allowed", host);
  return host;
}

function filterHeaders(src: RequestInit["headers"], allowed: ReadonlySet<string>, userAgent: string): Headers {
  const out = new Headers();
  new Headers(src ?? {}).forEach((value, key) => {
    const k = key.toLowerCase();
    if (k !== "user-agent" && allowed.has(k)) out.set(k, value);
  });
  out.set("user-agent", userAgent);
  return out;
}

function bodyBytes(body: RequestInit["body"]): number | null {
  if (body == null) return 0;
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return null;
}

function contentLength(res: Response): number | null {
  const v = res.headers.get("content-length");
  if (v === null || !/^\d+$/.test(v)) return null;
  return Number(v);
}

export function createGuardedFetch(policy: GuardPolicy): FetchLike {
  const allowedHosts = new Set(policy.allowedHosts.map((h) => h.toLowerCase()));
  const allowedHeaders = new Set(policy.allowedHeaderNames.map((h) => h.toLowerCase()));
  const userAgent = policy.userAgent ?? DEFAULT_USER_AGENT;
  const base = policy.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  return async (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) throw new GuardedFetchError("bad_input", null);
    let url: URL;
    try {
      url = new URL(String(input));
    } catch {
      throw new GuardedFetchError("bad_input", null);
    }
    let method = (init?.method ?? "GET").toUpperCase();
    let body = init?.body;
    const headers = filterHeaders(init?.headers, allowedHeaders, userAgent);

    for (let hop = 0; ; hop++) {
      const host = checkUrl(url, allowedHosts);
      const reqBytes = bodyBytes(body);
      let res: Response;
      try {
        res = await base(url.toString(), { ...init, method, body, headers, redirect: "manual" });
      } catch (err) {
        policy.onExchange?.({ name: policy.name, host, method, status: null, reqBytes, resBytes: null, error: err instanceof Error ? err.name : "unknown" });
        throw err;
      }
      policy.onExchange?.({ name: policy.name, host, method, status: res.status, reqBytes, resBytes: contentLength(res) });

      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location === null) return res;
      if (hop >= MAX_REDIRECTS) throw new GuardedFetchError("too_many_redirects", host);
      await res.body?.cancel();
      url = new URL(location, url);

      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
      }

      if (hostOf(url) !== host) {
        for (const k of ["authorization", "x-api-key", "x-goog-api-key"]) headers.delete(k);
      }
    }
  };
}
