import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_VERSION, createGuardedFetch, DEFAULT_USER_AGENT, GuardedFetchError, type ExchangeRecord, type FetchLike } from "../../src/model/guarded-fetch.ts";

type Seen = { url: string; init: RequestInit };

function stub(responses: Array<(url: string) => Response>): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error("no stub response");
    return r(url);
  };
  return { fetchImpl, seen };
}

const ok = () => new Response("{}", { status: 200, headers: { "content-length": "2" } });

describe("guardedFetch", () => {
  it("user agent version matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(AGENT_VERSION).toBe(pkg.version);
    expect(DEFAULT_USER_AGENT).toBe(`agent-guardrails/${pkg.version}`);
  });

  it("refuses hosts outside the allowlist", async () => {
    const { fetchImpl, seen } = stub([ok]);
    const f = createGuardedFetch({ name: "t", allowedHosts: ["api.example.com"], allowedHeaderNames: [], fetchImpl });
    await expect(f("https://evil.example.net/v1", {})).rejects.toMatchObject({ code: "host_not_allowed" });
    await expect(f("https://api.example.com.evil.net/v1", {})).rejects.toBeInstanceOf(GuardedFetchError);
    await expect(f("https://api.example.com:8443/v1", {})).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(seen).toHaveLength(0);
  });

  it("rejects http, URLs with credentials and Request objects", async () => {
    const { fetchImpl, seen } = stub([]);
    const f = createGuardedFetch({ name: "t", allowedHosts: ["api.example.com"], allowedHeaderNames: [], fetchImpl });
    await expect(f("http://api.example.com/v1")).rejects.toMatchObject({ code: "scheme_not_allowed" });
    await expect(f("https://u:p@api.example.com/v1")).rejects.toMatchObject({ code: "bad_input" });
    await expect(f(new Request("https://api.example.com/v1"))).rejects.toMatchObject({ code: "bad_input" });
    expect(seen).toHaveLength(0);
  });

  it("overwrites User-Agent and drops non-allowlisted headers", async () => {
    const { fetchImpl, seen } = stub([ok]);
    const f = createGuardedFetch({ name: "t", allowedHosts: ["api.example.com"], allowedHeaderNames: ["x-api-key", "Content-Type"], fetchImpl });
    await f("https://API.example.com/v1", {
      method: "POST",
      body: "{}",
      headers: { "x-api-key": "k", "content-type": "application/json", "user-agent": "ai-sdk-anthropic/4.0.82 runtime/node.js/24", "x-extra": "1" },
    });
    const h = new Headers(seen[0]?.init.headers);
    expect(h.get("user-agent")).toBe(DEFAULT_USER_AGENT);
    expect(h.get("x-api-key")).toBe("k");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("x-extra")).toBeNull();
    expect(seen[0]?.init.redirect).toBe("manual");
  });

  it("redirects: follows same host, refuses hosts outside the allowlist", async () => {
    const redirect = (loc: string) => () => new Response(null, { status: 302, headers: { location: loc } });
    const a = stub([redirect("/v2"), ok]);
    const f1 = createGuardedFetch({ name: "t", allowedHosts: ["api.example.com"], allowedHeaderNames: ["authorization"], fetchImpl: a.fetchImpl });
    expect((await f1("https://api.example.com/v1", { headers: { authorization: "Bearer k" } })).status).toBe(200);
    expect(a.seen.map((s) => s.url)).toEqual(["https://api.example.com/v1", "https://api.example.com/v2"]);
    expect(new Headers(a.seen[1]?.init.headers).get("authorization")).toBe("Bearer k");

    const b = stub([redirect("https://evil.example.net/steal")]);
    const f2 = createGuardedFetch({ name: "t", allowedHosts: ["api.example.com"], allowedHeaderNames: ["authorization"], fetchImpl: b.fetchImpl });
    await expect(f2("https://api.example.com/v1", { headers: { authorization: "Bearer k" } })).rejects.toMatchObject({ code: "host_not_allowed", host: "evil.example.net" });
    expect(b.seen).toHaveLength(1);
  });

  it("strips auth headers on cross-host redirects; at most 3 redirects", async () => {
    const c = stub([() => new Response(null, { status: 307, headers: { location: "https://b.example.com/x" } }), ok]);
    const f = createGuardedFetch({ name: "t", allowedHosts: ["a.example.com", "b.example.com"], allowedHeaderNames: ["authorization", "x-api-key"], fetchImpl: c.fetchImpl });
    await f("https://a.example.com/", { headers: { authorization: "Bearer k", "x-api-key": "k" } });
    const h = new Headers(c.seen[1]?.init.headers);
    expect(h.get("authorization")).toBeNull();
    expect(h.get("x-api-key")).toBeNull();

    const loop = () => new Response(null, { status: 302, headers: { location: "https://a.example.com/again" } });
    const d = stub([loop, loop, loop, loop, loop]);
    const g = createGuardedFetch({ name: "t", allowedHosts: ["a.example.com"], allowedHeaderNames: [], fetchImpl: d.fetchImpl });
    await expect(g("https://a.example.com/")).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(d.seen).toHaveLength(4);
  });

  it("records only host, status and size (no path, query or header values)", async () => {
    const recs: ExchangeRecord[] = [];
    const { fetchImpl } = stub([ok]);
    const f = createGuardedFetch({ name: "example", allowedHosts: ["api.example.com"], allowedHeaderNames: ["authorization"], fetchImpl, onExchange: (e) => recs.push(e) });
    await f("https://api.example.com/users/me/messages/SECRETID?q=TOKEN", { method: "POST", body: "BODYTEXT", headers: { authorization: "Bearer SECRETKEY" } });
    expect(recs).toEqual([{ name: "example", host: "api.example.com", method: "POST", status: 200, reqBytes: 8, resBytes: 2 }]);
    expect(JSON.stringify(recs)).not.toMatch(/SECRET|TOKEN|BODYTEXT/);
  });
});
