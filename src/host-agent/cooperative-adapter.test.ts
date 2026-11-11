import { describe, expect, test } from "bun:test";
import { createCooperativeAdapter, type CooperativeAdapterOptions } from "./cooperative-adapter.ts";
import { createHash } from "node:crypto";
import { MAX_TEXT } from "../commands.ts";
import { CentralAuth } from "../central/auth.ts";
import { createCooperativeCentralApp } from "../central/cooperative-server.ts";
import type { CooperativeCommands } from "../central/cooperative-server.ts";
import type { CooperativeClaims } from "../central/cooperative-claims.ts";
import type { CooperativeLifecycle } from "../central/cooperative-lifecycle.ts";

const localToken = "a".repeat(43);
const supervisorToken = "b".repeat(43);
const incarnationToken = "c".repeat(43);
const incarnationId = "12345678-1234-4123-8123-123456789abc";
const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

function fixture(fetcher: CooperativeAdapterOptions["centralFetch"] = (async () => Response.json({ jsonrpc: "2.0", id: 1, result: {} })) as CooperativeAdapterOptions["centralFetch"]) {
  const options: CooperativeAdapterOptions = { centralUrl: "https://central.example/mcp", localToken, supervisorToken, incarnationToken, incarnationId, centralFetch: fetcher };
  const handler = createCooperativeAdapter(options);
  const request = (url = "http://127.0.0.1:1234/mcp", init: RequestInit = {}) => handler(new Request(url, { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body: rpc, ...init }));
  return { options, request };
}

describe("isolated cooperative adapter", () => {
  test("forwards only to fixed central MCP endpoint with private headers", async () => {
    let seen: [string, RequestInit] | undefined;
    const { request } = fixture((async (url: string | URL | Request, init?: RequestInit) => { seen = [String(url), init!]; return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }, { headers: { "x-secret": supervisorToken } }); }) as CooperativeAdapterOptions["centralFetch"]);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(seen![0]).toBe("https://central.example/mcp");
    expect(seen![1].redirect).toBe("error");
    const headers = new Headers(seen![1].headers);
    expect(headers.get("authorization")).toBe(`Bearer ${supervisorToken}`);
    expect(headers.get("x-fleet-incarnation-id")).toBe(incarnationId);
    expect(headers.get("x-fleet-incarnation-token")).toBe(incarnationToken);
    expect(JSON.stringify([...response.headers])).not.toContain(supervisorToken);
  });

  test("rejects forged credentials, origin, methods, paths and oversized input without forwarding", async () => {
    let calls = 0;
    const { request } = fixture((async () => { calls++; return Response.json({}); }) as CooperativeAdapterOptions["centralFetch"]);
    const headers = (token = localToken, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", ...extra });
    expect((await request(undefined, { headers: headers("x".repeat(43)) })).status).toBe(401);
    expect((await request(undefined, { headers: headers(localToken, { origin: "http://127.0.0.1:1234" }) })).status).toBe(403);
    expect((await request(undefined, { method: "GET", body: undefined })).status).toBe(405);
    for (const url of ["http://127.0.0.1:1234/other", "http://127.0.0.1:1234/mcp?url=https://evil.test", "http://evil.test/mcp"]) expect((await request(url)).status).toBe(404);
    expect((await request(undefined, { body: "x".repeat(512 * 1024 + 1) })).status).toBe(413);
    expect((await request(undefined, { body: JSON.stringify({ method: "tools/list" }) })).status).toBe(400);
    expect(calls).toBe(0);
  });

  test("cancels every early-rejected body without forwarding or waiting", async () => {
    let calls = 0;
    let releaseFetch!: (response: Response) => void;
    const { options } = fixture(async () => { calls++; return new Promise((resolve) => { releaseFetch = resolve; }); });
    const handler = createCooperativeAdapter({ ...options, maxConcurrentRequests: 1 });
    const headers = { authorization: `Bearer ${localToken}`, "content-type": "application/json" };
    const busy = handler(new Request("http://localhost/mcp", { method: "POST", headers, body: rpc }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const aborted = new AbortController(); aborted.abort();
    const cases: Array<[string, RequestInit, number]> = [
      ["http://localhost/other", {}, 404],
      ["http://localhost/mcp", { method: "PUT" }, 405],
      ["http://localhost/mcp", { headers: { ...headers, origin: "http://localhost" } }, 403],
      ["http://localhost/mcp", { headers: { ...headers, authorization: "wrong" } }, 401],
      ["http://localhost/mcp", { headers: { ...headers, "content-type": "text/plain" } }, 415],
      ["http://localhost/mcp", { signal: aborted.signal }, 499],
      ["http://localhost/mcp", {}, 503],
    ];
    for (const [url, init, status] of cases) {
      let canceled = 0;
      const body = new ReadableStream({ cancel() { canceled++; return Promise.reject(new Error("cancel failed")); } });
      const request = new Request(url, { method: "POST", headers, ...init, body, duplex: "half" } as RequestInit);
      expect((await handler(request)).status).toBe(status);
      expect(canceled).toBe(1);
    }
    expect(calls).toBe(1);
    releaseFetch(Response.json({}));
    await busy;
  });

  test("bounds pending early cancellations, skips locked bodies and reuses settled slots", async () => {
    let calls = 0;
    const { options } = fixture(async () => { calls++; return Response.json({}); });
    const handler = createCooperativeAdapter(options);
    let canceled = 0;
    const releases: Array<() => void> = [];
    const makeRequest = () => new Request("http://localhost/other", { method: "POST", body: new ReadableStream({ cancel() { canceled++; return new Promise<void>((resolve) => { releases.push(resolve); }); } }), duplex: "half" } as RequestInit);
    const responses = Array.from({ length: 100 }, () => handler(makeRequest()));
    expect(canceled).toBe(16);
    for (const response of responses) expect((await response).status).toBe(404);
    const cap = canceled;
    const locked = makeRequest();
    const reader = locked.body!.getReader();
    releases[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await handler(locked)).status).toBe(404);
    expect(canceled).toBe(cap);
    reader.releaseLock();
    expect((await handler(makeRequest())).status).toBe(404);
    expect(canceled).toBe(cap + 1);
    for (const release of releases) release();
    expect(calls).toBe(0);
  });

  test("sanitizes upstream errors, headers and encoded secrets", async () => {
    for (const fetcher of [
      (async () => { throw new Error(`failure ${supervisorToken} ${incarnationToken}`); }),
      (async () => new Response(supervisorToken, { status: 500, headers: { "x-token": incarnationToken } })),
      (async () => Response.json({ result: `prefix ${supervisorToken}` }, { headers: { "x-token": incarnationToken } })),
      (async () => new Response(`{"result":"\\u0063${incarnationToken.slice(1)}"}`, { headers: { "content-type": "application/json" } })),
    ]) {
      const response = await fixture(fetcher as CooperativeAdapterOptions["centralFetch"]).request();
      const visible = `${JSON.stringify([...response.headers])} ${await response.text()}`;
      expect(response.status).toBe(502);
      for (const secret of [localToken, supervisorToken, incarnationToken, incarnationId]) expect(visible).not.toContain(secret);
    }
  });

  test("manual exact retry can recover a transient response failure without automatic retry", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "cooperative_claim", arguments: { requestId: "request-1" } } });
    for (const failure of ["drop", "non-success", "invalid", "oversized", "secret"]) {
      const committed = new Map<string, string>();
      let calls = 0;
      const { request } = fixture(async (_url, init) => {
        calls++;
        const headers = new Headers(init.headers);
        expect(headers.get("x-fleet-incarnation-id")).toBe(incarnationId);
        expect(headers.get("x-fleet-incarnation-token")).toBe(incarnationToken);
        const payload = String(init.body);
        const requestId = JSON.parse(payload).params.arguments.requestId as string;
        if (committed.has(requestId)) expect(committed.get(requestId)).toBe(payload);
        else committed.set(requestId, payload);
        // The fixture models a transient transport response, not a secret persisted in a command.
        if (calls > 1) return Response.json({ jsonrpc: "2.0", id: 7, result: { committed: true } });
        if (failure === "drop") throw new Error(supervisorToken);
        if (failure === "non-success") return new Response(supervisorToken, { status: 500 });
        if (failure === "invalid") return new Response("not JSON", { headers: { "content-type": "application/json" } });
        if (failure === "oversized") return new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } });
        return Response.json({ result: incarnationToken });
      });
      const first = await request(undefined, { body });
      const visible = `${JSON.stringify([...first.headers])} ${await first.text()}`;
      expect(first.status).toBe(502);
      expect(visible).toContain("outcome unknown");
      expect(visible).toContain("no automatic retry");
      expect(visible).toContain("exact request ID and payload with the same incarnation");
      for (const secret of [localToken, supervisorToken, incarnationToken, incarnationId]) expect(visible).not.toContain(secret);
      expect(calls).toBe(1);
      expect(committed.size).toBe(1);
      const retry = await request(undefined, { body });
      expect(retry.status).toBe(200);
      expect((await retry.json()).result.committed).toBe(true);
      expect(calls).toBe(2);
      expect(committed.size).toBe(1);
    }
  });

  test("passes maximum claim and report through the central MCP envelope", async () => {
    const principal = { name: "supervisor", role: "supervisor" as const, principalId: "id", hostId: "host", session: "session" };
    const auth = new CentralAuth([{ tokenHash: createHash("sha256").update(supervisorToken).digest("hex"), principal }]);
    const detail = "\u0001".repeat(65536);
    const text = "\u0001".repeat(MAX_TEXT);
    const command = { id: "cmd", idempotencyKey: "key", hostId: "host", target: "session", actor: "operator", text, status: "claimed", createdAt: "now", updatedAt: "now" };
    const claims = { async claim() { return command; } } as unknown as CooperativeClaims;
    const lifecycle = { async report(_p: unknown, _c: unknown, commandId: string, requestId: string, status: string, detail: string) { return { commandId, requestId, status, detail, at: "now" }; } } as unknown as CooperativeLifecycle;
    const app = createCooperativeCentralApp({ auth, identities: { async matches() { return true; } }, commands: {} as CooperativeCommands, claims, lifecycle, inspection: { async inspectBounded() { return null; } } });
    const { request } = fixture(async (url, init) => app.fetch(new Request(url, init)));
    const call = async (name: string, args: object) => {
      const response = await request(undefined, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.result.isError).not.toBe(true);
      return JSON.parse(result.result.content[0].text);
    };
    expect((await call("cooperative_claim", { requestId: "claim" })).command.text).toBe(text);
    expect((await call("cooperative_report", { commandId: "cmd", requestId: "report", status: "accepted", detail })).event.detail).toBe(detail);
  });

  test("rejects oversized request streams before forwarding", async () => {
    let calls = 0;
    let cancelled = false;
    const { request } = fixture(async () => { calls++; return Response.json({}); });
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { cancelled = true; },
    });
    const response = await request(undefined, { body, duplex: "half" } as RequestInit);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(calls).toBe(0);
  });

  test("rejects oversized upstream streams without buffering indefinitely", async () => {
    let cancelled = false;
    let count = 0;
    const { request } = fixture(async () => new Response(new ReadableStream({
      pull(controller) { count++; controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } }));
    expect((await request()).status).toBe(502);
    expect(cancelled).toBe(true);
    expect(count).toBeLessThanOrEqual(35);
  });

  test("bounds stalled input and never forwards it", async () => {
    let calls = 0;
    let canceled = false;
    const { options } = fixture(async () => { calls++; return Response.json({}); });
    const handler = createCooperativeAdapter({ ...options, requestTimeoutMs: 20 });
    const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { canceled = true; return new Promise(() => {}); } });
    const response = await handler(new Request("http://localhost/mcp", { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body, duplex: "half" } as RequestInit));
    expect(response.status).toBe(504);
    expect(await response.text()).toContain("before forwarding");
    expect(calls).toBe(0);
    expect(canceled).toBe(true);
  });

  test("times out an uncooperative fetch, holds its slot and cleans up a late body", async () => {
    let resolveFetch!: (response: Response) => void;
    let signal!: AbortSignal;
    let calls = 0;
    let canceled = false;
    const { options } = fixture(async (_url, init) => { calls++; signal = init.signal as AbortSignal; return new Promise((resolve) => { resolveFetch = resolve; }); });
    const handler = createCooperativeAdapter({ ...options, requestTimeoutMs: 20, maxConcurrentRequests: 1 });
    const request = () => handler(new Request("http://localhost/mcp", { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body: rpc }));
    const first = await request();
    expect(first.status).toBe(504);
    expect(await first.text()).toContain("outcome unknown; no automatic retry");
    expect(signal.aborted).toBe(true);
    expect((await request()).status).toBe(503);
    expect(calls).toBe(1);
    resolveFetch(new Response(new ReadableStream({ cancel() { canceled = true; throw new Error(supervisorToken); } })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(canceled).toBe(true);
    const pending = request();
    expect((await pending).status).toBe(504);
    expect(calls).toBe(2);
  });

  test("bounds a stalled upstream response and ignores rejected cancellation", async () => {
    let canceled = false;
    const { options } = fixture(async () => new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { canceled = true; return Promise.reject(new Error(supervisorToken)); },
    }), { headers: { "content-type": "application/json" } }));
    const handler = createCooperativeAdapter({ ...options, requestTimeoutMs: 20 });
    const response = await handler(new Request("http://localhost/mcp", { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body: rpc }));
    expect(response.status).toBe(504);
    expect(await response.text()).toContain("outcome unknown");
    expect(canceled).toBe(true);
  });

  test("applies the total deadline to trickling response streams", async () => {
    let canceled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const { options } = fixture(async () => new Response(new ReadableStream({
      start(controller) { timer = setInterval(() => controller.enqueue(new TextEncoder().encode(" ")), 5); },
      cancel() { canceled = true; clearInterval(timer); },
    }), { headers: { "content-type": "application/json" } }));
    const handler = createCooperativeAdapter({ ...options, requestTimeoutMs: 35 });
    const response = await handler(new Request("http://localhost/mcp", { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body: rpc }));
    expect(response.status).toBe(504);
    expect(canceled).toBe(true);
  });

  test("client abort interrupts a stalled fetch and aborts its signal", async () => {
    let signal!: AbortSignal;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { options } = fixture(async (_url, init) => { signal = init.signal as AbortSignal; started(); return new Promise(() => {}); });
    const handler = createCooperativeAdapter({ ...options, requestTimeoutMs: 1000 });
    const controller = new AbortController();
    const pending = handler(new Request("http://localhost/mcp", { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body: rpc, signal: controller.signal }));
    await ready;
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    const message = await response.text();
    expect(message).toContain("outcome unknown");
    expect(message).toContain("exact request ID and payload with the same incarnation");
    expect(message).toContain("no automatic retry");
    expect(signal.aborted).toBe(true);
  });

  test("enforces transport and separate credentials at construction", () => {
    const { options } = fixture();
    for (const centralUrl of ["http://central.example/mcp", "http://127.0.0.1/mcp", "https://central.example/other", "https://central.example/mcp?x=1", "https://user:pass@central.example/mcp"]) expect(() => createCooperativeAdapter({ ...options, centralUrl })).toThrow("invalid adapter configuration");
    expect(() => createCooperativeAdapter({ ...options, centralUrl: "http://127.0.0.1/mcp", allowLoopbackHttpForTests: true })).not.toThrow();
    expect(() => createCooperativeAdapter({ ...options, localToken: incarnationToken })).toThrow();
    for (const requestTimeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) expect(() => createCooperativeAdapter({ ...options, requestTimeoutMs })).toThrow();
    for (const maxConcurrentRequests of [0, -1, NaN, Infinity, 1.5, 1025]) expect(() => createCooperativeAdapter({ ...options, maxConcurrentRequests })).toThrow();
  });
});
