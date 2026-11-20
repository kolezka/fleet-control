import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Auth, parseTokens, tokenLine } from "./auth.ts";
import { Commands } from "./data/commands.ts";
import { Deliverer } from "./application/delivery.ts";
import type { Sender } from "./domain/delivery.ts";
import { Requests } from "./data/requests.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";
import { Credentials, GatewayConfigError, loadGatewayConfig, parseGatewayConfig, startGateway, type GatewayOptions } from "./client-gateway.ts";

// --- fake independent host services ------------------------------------------------------------

type Seen = { method: string; path: string; authorization: string | null; origin: string | null; cookie: string | null; body: string };
type Fake = ReturnType<typeof fakeHost>;

function fakeHost(label: string, token: string) {
  const seen: Seen[] = [];
  const sockets: { closeFromHost(code: number, reason?: string): void; received: unknown[] }[] = [];
  let hang = false;
  let big = false;
  let redirectTo = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const self = `http://127.0.0.1:${server.port}`;
      const record = async () => seen.push({
        method: req.method, path: url.pathname + url.search, authorization: req.headers.get("authorization"),
        origin: req.headers.get("origin"), cookie: req.headers.get("cookie"), body: req.method === "GET" ? "" : await req.text(),
      });
      if (url.pathname.endsWith("/terminal")) {
        seen.push({ method: "WS", path: url.pathname + url.search, authorization: req.headers.get("authorization"), origin: req.headers.get("origin"), cookie: req.headers.get("cookie"), body: "" });
        if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("no", { status: 401 });
        if (req.headers.get("origin") !== self) return new Response("no", { status: 403 });
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      }
      return (async () => {
        await record();
        if (hang) await Bun.sleep(5000);
        if (redirectTo) return new Response(null, { status: 302, headers: { location: redirectTo } });
        if (req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: { kind: "unauthorized", message: "missing or invalid token" } }, { status: 401 });
        if (req.method !== "GET" && req.headers.get("origin") !== self) return Response.json({ error: { kind: "forbidden", message: "cross-origin request" } }, { status: 403 });
        if (big) return new Response("x".repeat(200_000), { headers: { "content-type": "application/json" } });
        if (url.pathname === "/api/boom") return new Response(`stack trace with ${token}`, { status: 500 });
        if (url.pathname === "/api/sessions") return Response.json({ sessions: [{ name: "main", label }, { name: "worker", label }] });
        if (url.pathname === "/api/sessions/main/screen") return Response.json({ session: "main", text: `screen of ${label}` });
        if (url.pathname === "/api/commands" && req.method === "POST") return Response.json({ command: { id: `cmd-${label}`, status: "delivered" }, created: true }, { status: 201 });
        if (url.pathname === "/api/commands") return Response.json({ commands: [{ id: `cmd-${label}` }] });
        if (url.pathname.startsWith("/api/requests/") && url.pathname.endsWith("/resolve")) return Response.json({ request: { id: url.pathname.split("/")[3], by: label } });
        if (url.pathname === "/api/requests") return Response.json({ requests: [] });
        return Response.json({ error: { kind: "not_found", message: "not found" } }, { status: 404 });
      })();
    },
    websocket: {
      open(ws) {
        const rec = { received: [] as unknown[], closeFromHost: (c: number, reason = "host closing") => ws.close(c, reason) };
        (ws as any).rec = rec;
        sockets.push(rec);
        ws.sendBinary(new Uint8Array([0x1b, 0x5b, 0x00, 0xff, 0xfe, 0x80]));
        ws.sendText("text-frame");
      },
      message(ws, m) {
        (ws as any).rec.received.push(m);
      },
    },
  });
  return {
    label, token, server, seen, sockets,
    origin: `http://127.0.0.1:${server.port}`,
    set hang(v: boolean) { hang = v; },
    set big(v: boolean) { big = v; },
    set redirectTo(v: string) { redirectTo = v; },
    stop: () => server.stop(true),
  };
}

// --- harness -----------------------------------------------------------------------------------

let a: Fake, b: Fake, leak: ReturnType<typeof Bun.serve>;
let leakHits: string[];
let gw: ReturnType<typeof startGateway>;
let dir: string;

function startWith(opts: GatewayOptions = {}, hosts: Fake[] = [a, b]) {
  const tokens = new Map(hosts.map((h) => [h.label, h.token]));
  return startGateway(
    { hosts: hosts.map((h) => ({ id: h.label, name: `Host ${h.label.toUpperCase()}`, origin: h.origin })), credentials: new Credentials(tokens) },
    { port: 0, ...opts },
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "client-gateway-"));
});
afterAll(() => {
  if (dir.startsWith(join(tmpdir(), "client-gateway-"))) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  leakHits = [];
  leak = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => (leakHits.push(`${r.method} ${r.headers.get("authorization")}`), new Response("leaked")) });
  a = fakeHost("a", "token-for-host-a-aaaaaaaa");
  b = fakeHost("b", "token-for-host-b-bbbbbbbb");
  gw = startWith();
});
afterEach(() => {
  gw.stop(true);
  a.stop();
  b.stop();
  leak.stop(true);
});

test("the approval page refuses framing", async () => {
  const page = await fetch(`${gw.url}`);
  expect(page.headers.get("x-frame-options")).toBe("DENY");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});

const base = () => `http://127.0.0.1:${gw.port}`;
const page = () => `http://127.0.0.1:${gw.port}`;
const get = (path: string, headers: Record<string, string> = {}) => fetch(base() + path, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = { origin: page() }) =>
  fetch(base() + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

function openWs(path: string, headers: Record<string, string> = { origin: page() }) {
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}${path}`, { headers } as never);
  ws.binaryType = "arraybuffer";
  const frames: (string | ArrayBuffer)[] = [];
  let closed: { code: number; reason: string } | null = null;
  const opened = new Promise<boolean>((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); });
  ws.onmessage = (e) => frames.push(e.data);
  const closedP = new Promise<{ code: number; reason: string }>((r) => { ws.onclose = (e) => { closed = { code: e.code, reason: e.reason }; r(closed); }; });
  return { ws, frames, opened, closedP, get closed() { return closed; } };
}
const until = async (f: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await Bun.sleep(10);
  expect(f()).toBe(true);
};

// --- config ------------------------------------------------------------------------------------

describe("config", () => {
  const ok = { id: "mini", name: "Mac mini", url: "https://mini.lan:4871", tokenFile: "mini.token" };
  const parse = (h: unknown, extra: object = {}) => parseGatewayConfig({ hosts: [h], ...extra }, "/etc/fc");

  test("accepts https and loopback http, resolves relative tokenFile against the config directory", () => {
    const [h] = parse(ok);
    expect(h).toEqual({ id: "mini", name: "Mac mini", origin: "https://mini.lan:4871", tokenFile: "/etc/fc/mini.token" });
    expect(parse({ ...ok, url: "http://127.0.0.1:4871", tokenFile: "/abs/t" })[0]).toMatchObject({ origin: "http://127.0.0.1:4871", tokenFile: "/abs/t" });
    expect(parse({ ...ok, url: "http://localhost:4871/" })[0]!.origin).toBe("http://localhost:4871");
  });

  test.each([
    ["plain http to a LAN host", { url: "http://192.168.50.4:4871" }],
    ["http to a public name that merely starts with localhost", { url: "http://localhost.evil.example" }],
    ["url with a path", { url: "https://mini.lan/api" }],
    ["url with credentials", { url: "https://u:p@mini.lan" }],
    ["url with a query", { url: "https://mini.lan/?x=1" }],
    ["url with a fragment", { url: "https://mini.lan/#x" }],
    ["non-http scheme", { url: "ftp://mini.lan" }],
    ["id with a slash", { id: "a/b" }],
    ["id with uppercase", { id: "Mini" }],
    ["empty id", { id: "" }],
    ["id that is a dot path", { id: ".." }],
    ["empty name", { name: " " }],
    ["control characters in the name", { name: "a\nb" }],
    ["insecure override key", { insecureSkipVerify: true }],
    ["missing tokenFile", { tokenFile: "" }],
  ])("rejects %s", (_n, patch) => {
    expect(() => parse({ ...ok, ...patch })).toThrow(GatewayConfigError);
  });

  test("rejects duplicate ids, empty host lists and unknown top-level keys", () => {
    expect(() => parseGatewayConfig({ hosts: [ok, ok] }, "/")).toThrow(/duplicate id/);
    expect(() => parseGatewayConfig({ hosts: [] }, "/")).toThrow(GatewayConfigError);
    expect(() => parse(ok, { tls: { rejectUnauthorized: false } })).toThrow(/unknown key/);
    expect(() => parseGatewayConfig([], "/")).toThrow(GatewayConfigError);
  });

  test("loads token files relative to the config file and never prints the token", async () => {
    writeFileSync(join(dir, "a.token"), "secret-token-a-1234\n");
    writeFileSync(join(dir, "b.token"), "secret-token-b-5678\n");
    writeFileSync(join(dir, "fc.json"), JSON.stringify({ hosts: [
      { id: "a", name: "A", url: "https://a.lan:4871", tokenFile: "a.token" },
      { id: "b", name: "B", url: "https://b.lan:4871", tokenFile: "./b.token" },
    ] }));
    const cfg = await loadGatewayConfig(join(dir, "fc.json"));
    expect(cfg.credentials.bearer("a")).toBe("secret-token-a-1234");
    expect(cfg.credentials.bearer("b")).toBe("secret-token-b-5678");
    expect(JSON.stringify(cfg)).not.toContain("secret-token");
    expect(Bun.inspect(cfg)).not.toContain("secret-token");
  });

  test("errors name the file and host but never the token content", async () => {
    writeFileSync(join(dir, "bad.token"), "has a space inside secretbits");
    writeFileSync(join(dir, "same1.token"), "shared-token-value-1");
    writeFileSync(join(dir, "same2.token"), "shared-token-value-1");
    const cfg = (name: string, hosts: object[]) => (writeFileSync(join(dir, name), JSON.stringify({ hosts })), join(dir, name));
    const h = (id: string, tokenFile: string) => ({ id, name: id, url: "https://x.lan", tokenFile });
    const bad = await loadGatewayConfig(cfg("c1.json", [h("a", "bad.token")])).catch((e) => e as Error);
    expect(bad).toBeInstanceOf(GatewayConfigError);
    expect((bad as Error).message).not.toContain("secretbits");
    expect(String(await loadGatewayConfig(cfg("c2.json", [h("a", "nope.token")])).catch((e) => e))).toContain('host "a"');
    expect(String(await loadGatewayConfig(cfg("c3.json", [h("a", "same1.token"), h("b", "same2.token")])).catch((e) => e))).toContain("share one token");
    expect(String(await loadGatewayConfig(join(dir, "missing.json")).catch((e) => e))).toContain("cannot read config");
  });
});

// --- hosts, routing, isolation -----------------------------------------------------------------

describe("routing and credential isolation", () => {
  test("GET /api/hosts lists configured hosts with apiBase and no secrets", async () => {
    const res = await get("/api/hosts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hosts: [
      { id: "a", name: "Host A", apiBase: "/api/hosts/a" },
      { id: "b", name: "Host B", apiBase: "/api/hosts/b" },
    ] });
    expect(JSON.stringify(body)).not.toContain(a.token);
    expect(JSON.stringify(body)).not.toContain(a.origin);
  });

  test("same session names resolve per host, each host sees only its own token and its own Origin", async () => {
    const [sa, sb] = await Promise.all([get("/api/hosts/a/sessions"), get("/api/hosts/b/sessions")]);
    expect((await sa.json()).sessions.map((s: any) => s.label)).toEqual(["a", "a"]);
    expect((await sb.json()).sessions.map((s: any) => s.label)).toEqual(["b", "b"]);
    const [ra, rb] = await Promise.all([get("/api/hosts/a/sessions/main/screen?lines=20"), get("/api/hosts/b/sessions/main/screen")]);
    expect((await ra.json()).text).toBe("screen of a");
    expect((await rb.json()).text).toBe("screen of b");
    for (const [h, other] of [[a, b], [b, a]] as const) {
      expect(h.seen.length).toBeGreaterThan(0);
      for (const s of h.seen) {
        expect(s.authorization).toBe(`Bearer ${h.token}`);
        expect(s.authorization).not.toContain(other.token);
        expect(s.origin).toBe(h.origin);
      }
    }
    expect(a.seen.map((s) => s.path)).toContain("/api/sessions/main/screen?lines=20");
  });

  test("browser credentials and cookies are never forwarded; the gateway token replaces them", async () => {
    await get("/api/hosts/a/sessions", { authorization: "Bearer browser-supplied", cookie: "fc_session=stolen" });
    await post("/api/hosts/a/commands", { text: "x" }, { origin: page(), authorization: "Bearer browser-supplied", cookie: "fc_session=stolen" });
    expect(a.seen.length).toBe(2);
    for (const s of a.seen) {
      expect(s.authorization).toBe(`Bearer ${a.token}`);
      expect(s.cookie).toBeNull();
      expect(s.origin).toBe(a.origin);
    }
  });

  test("commands and resolve go to the chosen host only", async () => {
    const c = await post("/api/hosts/b/commands", { idempotencyKey: "k-123456789", target: "main", text: "hi" });
    expect(c.status).toBe(201);
    expect((await c.json()).command.id).toBe("cmd-b");
    expect(a.seen.filter((s) => s.method === "POST")).toHaveLength(0);
    expect(JSON.parse(b.seen.at(-1)!.body)).toEqual({ idempotencyKey: "k-123456789", target: "main", text: "hi" });

    const r = await post("/api/hosts/a/requests/req-1/resolve", { response: "approve", expectedRevision: 2 });
    expect((await r.json()).request).toEqual({ id: "req-1", by: "a" });
    expect(b.seen.filter((s) => s.path.includes("resolve"))).toHaveLength(0);
    expect(JSON.parse(a.seen.at(-1)!.body)).toEqual({ response: "approve", expectedRevision: 2 });

    expect((await (await get("/api/hosts/a/commands")).json()).commands[0].id).toBe("cmd-a");
    expect((await (await get("/api/hosts/b/commands/cmd-b")).status)).toBe(404); // fake has no such route; status is passed on
    expect((await (await get("/api/hosts/a/requests")).json()).requests).toEqual([]);
  });

  test("only allowlisted paths, methods and query parameters reach a host", async () => {
    const hitsBefore = a.seen.length;
    const cases: [string, string][] = [
      ["GET", "/api/hosts/a/whoami"],
      ["GET", "/api/hosts/a/login"],
      ["GET", "/api/hosts/a/sessions/main"],
      ["GET", "/api/hosts/a/sessions/main/screen/extra"],
      ["GET", "/api/hosts/a/sessions/..%2f..%2fx/screen"],
      ["GET", "/api/hosts/a/sessions/%2e%2e/screen"],
      ["GET", "/api/hosts/a//api/sessions"],
      ["GET", "/api/hosts/a/commands/x/y"],
      ["GET", "/api/hosts/nope/sessions"],
      ["GET", "/api/hosts/a"],
      ["GET", "/api/hosts/a/"],
      ["GET", "/api/hosts/a/mcp/extra"],
    ];
    for (const [method, path] of cases) {
      const res = await fetch(base() + path, { method, headers: { origin: page() } });
      expect([404, 405, 400]).toContain(res.status);
    }
    for (const [method, path] of [["DELETE", "/api/hosts/a/commands"], ["PUT", "/api/hosts/a/commands"], ["POST", "/api/hosts/a/sessions"], ["POST", "/api/hosts/a/requests"], ["GET", "/api/hosts/a/requests/r1/resolve"], ["PATCH", "/api/hosts/a/commands/c1"], ["POST", "/api/hosts/a/commands/c1"]] as const) {
      const res = await fetch(base() + path, { method, headers: { origin: page(), "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect(res.status).toBe(405);
    }
    expect((await get("/api/hosts/a/sessions/main/screen?lines=abc")).status).toBe(400);
    expect((await get("/api/hosts/a/sessions/main/screen?lines=5&evil=1")).status).toBe(200);
    expect(a.seen.slice(hitsBefore).map((s) => s.path)).toEqual(["/api/sessions/main/screen?lines=5"]);
    // List paging passes through; anything else on the query is dropped or refused.
    expect((await get("/api/hosts/a/commands?limit=2&cursor=eyJ2IjpbXX0&status=x")).status).toBe(200);
    expect((await get("/api/hosts/a/requests?limit=3")).status).toBe(200);
    expect((await get("/api/hosts/a/commands?cursor=not%20base64")).status).toBe(400);
    expect((await get("/api/hosts/a/requests?limit=12345")).status).toBe(400);
    expect((await get("/api/hosts/a/commands?latest=6&status=x")).status).toBe(200);
    expect((await get("/api/hosts/a/commands?latest=abc")).status).toBe(400);
    expect((await get("/api/hosts/a/requests?view=current")).status).toBe(200);
    expect((await get("/api/hosts/a/requests?view=all")).status).toBe(400);
    expect(a.seen.slice(hitsBefore + 1).map((s) => s.path)).toEqual(["/api/commands?limit=2&cursor=eyJ2IjpbXX0", "/api/requests?limit=3", "/api/commands?latest=6", "/api/requests?view=current"]);
    expect((await fetch(base() + "/api/hosts", { method: "POST", headers: { origin: page() } })).status).toBe(405);
    expect((await get("/other")).status).toBe(404);
  });

  test("writes require application/json and a bounded body", async () => {
    const wrongType = await fetch(`${base()}/api/hosts/a/commands`, { method: "POST", headers: { origin: page(), "content-type": "text/plain" }, body: "x" });
    expect(wrongType.status).toBe(415);
    const huge = await post("/api/hosts/a/commands", { text: "x".repeat(100_000) });
    expect(huge.status).toBe(413);
    const chunked = await fetch(`${base()}/api/hosts/a/commands`, {
      method: "POST", headers: { origin: page(), "content-type": "application/json" },
      body: new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode("x".repeat(40_000))); } , cancel() {} }),
      duplex: "half",
    } as never).catch(() => null);
    if (chunked) expect(chunked.status).toBe(413);
    expect(a.seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });
});

// --- failure isolation -------------------------------------------------------------------------

describe("upstream failures", () => {
  test("an offline host does not block the other; its writes report an unknown outcome", async () => {
    b.stop();
    const t = Date.now();
    const [down, up, downWrite] = await Promise.all([
      get("/api/hosts/b/sessions"),
      get("/api/hosts/a/sessions"),
      post("/api/hosts/b/commands", { idempotencyKey: "k-123456789", target: "main", text: "hi" }),
    ]);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(up.status).toBe(200);
    expect((await up.json()).sessions[0].label).toBe("a");
    expect(down.status).toBe(502);
    const dj = await down.json();
    expect(dj.error).toMatchObject({ kind: "upstream_unreachable", host: "b" });
    expect(dj.error.outcome).toBeUndefined();
    expect(downWrite.status).toBe(502);
    expect((await downWrite.json()).error).toMatchObject({ kind: "upstream_unreachable", host: "b", outcome: "unknown" });
    // Host list still works and the healthy host still serves writes.
    expect((await get("/api/hosts")).status).toBe(200);
    expect((await post("/api/hosts/a/commands", { text: "ok" })).status).toBe(201);
  });

  test("timeouts are bounded; a timed-out write is reported unknown and is never retried", async () => {
    gw.stop(true);
    gw = startWith({ timeoutMs: 150 });
    a.hang = true;
    const t = Date.now();
    const read = await get("/api/hosts/a/sessions");
    const write = await post("/api/hosts/a/commands", { idempotencyKey: "k-123456789", target: "main", text: "hi" });
    expect(Date.now() - t).toBeLessThan(2500);
    expect(read.status).toBe(504);
    expect((await read.json()).error.outcome).toBeUndefined();
    expect(write.status).toBe(504);
    expect((await write.json()).error).toMatchObject({ kind: "upstream_timeout", outcome: "unknown" });
    await Bun.sleep(400);
    expect(a.seen.filter((s) => s.method === "POST")).toHaveLength(1);
    expect(a.seen.filter((s) => s.method === "GET")).toHaveLength(1);
    expect((await get("/api/hosts/b/sessions")).status).toBe(200);
  });

  test("redirects are not followed and credentials do not follow them", async () => {
    a.redirectTo = `http://127.0.0.1:${leak.port}/steal`;
    const read = await get("/api/hosts/a/sessions");
    const write = await post("/api/hosts/a/commands", { text: "hi" });
    expect(read.status).toBe(502);
    expect((await read.json()).error.kind).toBe("upstream_redirect");
    expect(write.status).toBe(502);
    expect((await write.json()).error).toMatchObject({ kind: "upstream_redirect", outcome: "unknown" });
    expect(read.headers.get("location")).toBeNull();
    expect(leakHits).toEqual([]);
  });

  test("a redirecting terminal upgrade is not followed either", async () => {
    const redirecting = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${leak.port}/ws` } }) });
    const g = startGateway(
      { hosts: [{ id: "r", name: "R", origin: `http://127.0.0.1:${redirecting.port}` }], credentials: new Credentials(new Map([["r", "tok-r-tok-r-tok"]])) },
      { port: 0 },
    );
    const origin = `http://127.0.0.1:${g.port}`;
    const ws = new WebSocket(`ws://127.0.0.1:${g.port}/api/hosts/r/sessions/main/terminal`, { headers: { origin } } as never);
    const opened = await new Promise<boolean>((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); ws.onclose = () => r(false); });
    expect(opened).toBe(false);
    expect(leakHits).toEqual([]);
    g.stop(true);
    redirecting.stop(true);
  });

  test("upstream errors are masked and carry no secrets, paths or foreign bodies", async () => {
    const boom = await Promise.all([
      fetch(a.origin + "/api/boom", { headers: { authorization: `Bearer ${a.token}` } }).then((r) => r.status),
    ]);
    expect(boom).toEqual([500]); // sanity: the fake would leak if it were relayed
    // A real route that the fake answers with 500: use a host whose handler throws on the route.
    const failing = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`Error at /home/me/secret.ts token=${a.token}`, { status: 500 }) });
    const unauth = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { kind: "unauthorized", message: `bad token ${a.token}` } }, { status: 401 }) });
    const g = startGateway(
      { hosts: [
        { id: "f", name: "F", origin: `http://127.0.0.1:${failing.port}` },
        { id: "u", name: "U", origin: `http://127.0.0.1:${unauth.port}` },
      ], credentials: new Credentials(new Map([["f", "tok-f-tok-f-tok"], ["u", "tok-u-tok-u-tok"]])) },
      { port: 0 },
    );
    const gb = `http://127.0.0.1:${g.port}`;
    const f = await fetch(`${gb}/api/hosts/f/sessions`);
    const ft = await f.text();
    expect(f.status).toBe(502);
    expect(ft).not.toContain("secret.ts");
    expect(ft).not.toContain(a.token);
    expect(JSON.parse(ft).error.kind).toBe("upstream_error");
    const u = await fetch(`${gb}/api/hosts/u/sessions`);
    const ut = await u.text();
    expect(u.status).toBe(502);
    expect(ut).not.toContain(a.token);
    expect(JSON.parse(ut).error.kind).toBe("upstream_unauthorized");
    g.stop(true);
    failing.stop(true);
    unauth.stop(true);
  });

  test("an oversized upstream response is refused", async () => {
    gw.stop(true);
    gw = startWith({ maxResponseBytes: 50_000 });
    a.big = true;
    const res = await get("/api/hosts/a/sessions");
    expect(res.status).toBe(502);
    expect((await res.json()).error.kind).toBe("upstream_too_large");
    expect((await get("/api/hosts/b/sessions")).status).toBe(200);
  });

  test("the host's own 4xx answer keeps its status and kind but not extra fields", async () => {
    const rich = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { kind: "conflict", message: "revision is stale", debug: "/srv/x" } }, { status: 409 }) });
    const g = startGateway({ hosts: [{ id: "r", name: "R", origin: `http://127.0.0.1:${rich.port}` }], credentials: new Credentials(new Map([["r", "tok-r-tok-r-tok"]])) }, { port: 0 });
    const res = await fetch(`http://127.0.0.1:${g.port}/api/hosts/r/requests/req-1/resolve`, {
      method: "POST", headers: { origin: `http://127.0.0.1:${g.port}`, "content-type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { kind: "conflict", message: "revision is stale", host: "r" } });
    g.stop(true);
    rich.stop(true);
  });
});

// --- CSRF and DNS rebinding --------------------------------------------------------------------

describe("browser attack surface", () => {
  test("a rebinding Host header is refused on every API route and nothing reaches a host", async () => {
    for (const host of ["evil.example", `evil.example:${gw.port}`, `127.0.0.1.evil.example:${gw.port}`, "127.0.0.1", `[::1]:${gw.port}`]) {
      for (const path of ["/api/hosts", "/api/hosts/a/sessions", "/api/hosts/a/commands"]) {
        const res = await get(path, { host });
        expect(res.status).toBe(403);
      }
    }
    expect(a.seen).toHaveLength(0);
    // The alias localhost with the right port is the same loopback listener and is accepted.
    expect((await get("/api/hosts", { host: `localhost:${gw.port}` })).status).toBe(200);
  });

  test("a foreign Origin is refused for reads and writes; a missing Origin is refused for writes", async () => {
    const evil = "https://evil.example";
    expect((await get("/api/hosts/a/sessions", { origin: evil })).status).toBe(403);
    expect((await get("/api/hosts/a/sessions", { origin: "http://localhost:" + gw.port })).status).toBe(403); // a different origin string than the Host used
    expect((await post("/api/hosts/a/commands", { text: "x" }, { origin: evil })).status).toBe(403);
    expect((await post("/api/hosts/a/commands", { text: "x" }, { origin: "null" })).status).toBe(403);
    expect((await post("/api/hosts/a/commands", { text: "x" }, {})).status).toBe(403);
    expect((await post("/api/hosts/a/requests/r1/resolve", { response: "approve", expectedRevision: 1 }, {})).status).toBe(403);
    expect((await post("/api/hosts/a/requests/r1/resolve", { response: "approve", expectedRevision: 1 }, { origin: evil })).status).toBe(403);
    expect((await post("/api/hosts/a/mcp", {}, { origin: evil })).status).toBe(403);
    expect(a.seen).toHaveLength(0);
    // Absent Origin on a GET is fine (address bar, curl).
    expect((await get("/api/hosts/a/sessions")).status).toBe(200);
  });

  test("Sec-Fetch-Site cross-site and same-site requests are refused, same-origin accepted", async () => {
    expect((await get("/api/hosts/a/sessions", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get("/api/hosts/a/sessions", { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await post("/api/hosts/a/commands", { text: "x" }, { origin: page(), "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get("/api/hosts/a/sessions", { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await get("/api/hosts/a/sessions", { "sec-fetch-site": "none" })).status).toBe(200);
  });

  test("terminal sockets need the same Origin and the right Host", async () => {
    const path = "/api/hosts/a/sessions/main/terminal";
    for (const headers of [{} as Record<string, string>, { origin: "https://evil.example" }, { origin: "null" }, { origin: page(), host: "evil.example" }]) {
      const c = openWs(path, headers);
      expect(await c.opened).toBe(false);
    }
    expect(a.seen).toHaveLength(0);
    const good = openWs(path);
    expect(await good.opened).toBe(true);
    good.ws.close();
  });

  test("the page itself is served and carries no credentials", async () => {
    const res = await fetch(base() + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<html");
    expect(html).not.toContain(a.token);
  });
});

// --- read-only terminal relay ------------------------------------------------------------------

describe("terminal relay", () => {
  const path = "/api/hosts/a/sessions/main/terminal?cols=100&rows=30";

  test("binary and text frames arrive intact, upstream gets host auth and Origin, hosts stay separate", async () => {
    const c = openWs(path);
    expect(await c.opened).toBe(true);
    await until(() => c.frames.length >= 2);
    const bin = c.frames[0] as ArrayBuffer;
    expect([...new Uint8Array(bin)]).toEqual([0x1b, 0x5b, 0x00, 0xff, 0xfe, 0x80]);
    expect(c.frames[1]).toBe("text-frame");
    const hit = a.seen.find((s) => s.method === "WS")!;
    expect(hit.path).toBe("/api/sessions/main/terminal?cols=100&rows=30");
    expect(hit.authorization).toBe(`Bearer ${a.token}`);
    expect(hit.origin).toBe(a.origin);
    expect(hit.cookie).toBeNull();
    expect(b.seen).toHaveLength(0);
    c.ws.close();
  });

  test("browser text messages close with 1008 and are never forwarded", async () => {
    const c = openWs(path);
    await c.opened;
    await until(() => c.frames.length >= 2);
    c.ws.send("rm -rf /\r");
    c.ws.send(new Uint8Array([0x03]));
    expect((await c.closedP).code).toBe(1008);
    await until(() => a.sockets.length === 1);
    await Bun.sleep(100);
    expect(a.sockets[0]!.received).toEqual([]);
  });

  // The host decides: it types only for the socket holding the input lease and closes any other.
  test("browser key bytes go to the host unchanged and only to that host", async () => {
    const c = openWs(path);
    await c.opened;
    await until(() => c.frames.length >= 2);
    c.ws.send(new Uint8Array([0x61, 0x03, 0x1b, 0x5b, 0x41, 0x0d]));
    await until(() => a.sockets[0]?.received.length === 1);
    expect([...new Uint8Array(a.sockets[0]!.received[0] as ArrayBuffer | Uint8Array)]).toEqual([0x61, 0x03, 0x1b, 0x5b, 0x41, 0x0d]);
    expect(b.sockets).toHaveLength(0);
    // 4 KiB fits one message; more is refused before it reaches the host.
    c.ws.send(new Uint8Array(4097));
    expect((await c.closedP).code).toBe(1009);
    expect(a.sockets[0]!.received).toHaveLength(1);
  });

  test("upstream close tears down the browser socket", async () => {
    const c = openWs(path);
    await c.opened;
    await until(() => a.sockets.length === 1);
    a.sockets[0]!.closeFromHost(1000);
    const closed = await c.closedP;
    expect([1000, 1011]).toContain(closed.code);
  });

  // A host revoking "token revoked" means the gateway's own host token, so the page must not tell the user to sign in.
  test("the host's close code and a short printable reason reach the page; anything else is replaced", async () => {
    for (const [reason, seen] of [["token revoked", "gateway token revoked"], ["read-only terminal", "read-only terminal"], ["bad\u0007bell", "upstream closed"], ["x".repeat(121), "upstream closed"]] as const) {
      const c = openWs(path);
      await c.opened;
      await until(() => a.sockets.length >= 1);
      a.sockets.at(-1)!.closeFromHost(1008, reason);
      expect(await c.closedP).toEqual({ code: 1008, reason: seen });
      a.sockets.length = 0;
    }
  });

  test("browser close tears down the upstream socket", async () => {
    const c = openWs(path);
    await c.opened;
    await until(() => a.sockets.length === 1);
    c.ws.close();
    await until(() => a.server.pendingWebSockets === 0);
  });

  test("an unreachable host gives a plain 502 for the upgrade and does not affect the other host", async () => {
    b.stop();
    const down = openWs("/api/hosts/b/sessions/main/terminal");
    expect(await down.opened).toBe(false);
    const up = openWs(path);
    expect(await up.opened).toBe(true);
    up.ws.close();
    const plain = await fetch(base() + "/api/hosts/b/sessions/main/terminal", { headers: { origin: page(), upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    expect(plain.status).toBe(502);
  });

  test("an upstream that rejects the gateway credentials is refused, not relayed", async () => {
    const bad = fakeHost("c", "other-token-other-token");
    const g = startGateway({ hosts: [{ id: "c", name: "C", origin: bad.origin }], credentials: new Credentials(new Map([["c", "wrong-token-wrong-token"]])) }, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${g.port}/api/hosts/c/sessions/main/terminal`, { headers: { origin: `http://127.0.0.1:${g.port}` } } as never);
    expect(await new Promise<boolean>((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); ws.onclose = () => r(false); })).toBe(false);
    g.stop(true);
    bad.stop();
  });

  test("a burst of frames keeps order and content", async () => {
    const burst = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: { open(ws) { for (let i = 0; i < 500; i++) ws.sendBinary(new Uint8Array([i & 0xff, (i >> 8) & 0xff, 0xff])); ws.sendText("end"); } },
    });
    const g = startGateway({ hosts: [{ id: "x", name: "X", origin: `http://127.0.0.1:${burst.port}` }], credentials: new Credentials(new Map([["x", "tok-x-tok-x-tok"]])) }, { port: 0 });
    const frames: (string | ArrayBuffer)[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${g.port}/api/hosts/x/sessions/main/terminal`, { headers: { origin: `http://127.0.0.1:${g.port}` } } as never);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => frames.push(e.data);
    await until(() => frames.length === 501);
    frames.slice(0, 500).forEach((f, i) => expect([...new Uint8Array(f as ArrayBuffer)]).toEqual([i & 0xff, (i >> 8) & 0xff, 0xff]));
    expect(frames[500]).toBe("end");
    ws.close();
    g.stop(true);
    burst.stop(true);
  });

  test("a host at its viewer cap closes at once with 1013, and the page gets that code and reason", async () => {
    const full = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: { open(ws) { ws.close(1013, "too many open terminal viewers"); }, message() {} },
    });
    const g = startGateway({ hosts: [{ id: "f", name: "F", origin: `http://127.0.0.1:${full.port}` }], credentials: new Credentials(new Map([["f", "tok-f-tok-f-tok"]])) }, { port: 0 });
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${g.port}/api/hosts/f/sessions/main/terminal`, { headers: { origin: `http://127.0.0.1:${g.port}` } } as never);
      expect(await new Promise((r) => { ws.onclose = (e) => r({ code: e.code, reason: e.reason }); })).toEqual({ code: 1013, reason: "too many open terminal viewers" });
    }
    g.stop(true);
    full.stop(true);
  });

  test("an oversized upstream frame closes both sides", async () => {
    const huge = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: { open(ws) { ws.sendBinary(new Uint8Array(5000)); } },
    });
    const g = startGateway({ hosts: [{ id: "h", name: "H", origin: `http://127.0.0.1:${huge.port}` }], credentials: new Credentials(new Map([["h", "tok-h-tok-h-tok"]])) }, { port: 0, maxFrameBytes: 1000 });
    const ws = new WebSocket(`ws://127.0.0.1:${g.port}/api/hosts/h/sessions/main/terminal`, { headers: { origin: `http://127.0.0.1:${g.port}` } } as never);
    const got: number[] = [];
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => got.push((e.data as ArrayBuffer).byteLength);
    const code = await new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
    expect(code).toBe(1009);
    expect(got).toEqual([]);
    g.stop(true);
    huge.stop(true);
  });
});

// --- real host service, including MCP ----------------------------------------------------------

describe("against the real host service", () => {
  test("REST writes and the per-host MCP proxy work end to end with a bearer-protected host", async () => {
    const token = "real-host-token-0123456789";
    const sent: string[] = [];
    const fakeSend: Sender = async (session) => (sent.push(session), { exitCode: 0, stdout: "ok", stderr: "" });
    const store = new Store(":memory:");
    const commands = new Commands(store.db);
    const host = serve(
      { fleet: { screen: async () => "", status: async () => ({ raw: "", sessions: [{ name: "main", running: true, contextPct: null }] }) } as never, store, control: { commands, deliverer: new Deliverer(commands, fakeSend), requests: new Requests(store.db) } },
      0,
      { auth: new Auth(parseTokens(tokenLine("gateway", token))) },
    );
    const g = startGateway({ hosts: [{ id: "real", name: "Real", origin: `http://127.0.0.1:${host.port}` }], credentials: new Credentials(new Map([["real", token]])) }, { port: 0 });
    const gb = `http://127.0.0.1:${g.port}`;
    try {
      // The host rejects anything without its token; through the gateway it works.
      expect((await fetch(`${host.url}api/sessions`)).status).toBe(401);
      const sessions = await (await fetch(`${gb}/api/hosts/real/sessions`)).json();
      expect(sessions.sessions[0].name).toBe("main");

      const cmd = await fetch(`${gb}/api/hosts/real/commands`, {
        method: "POST", headers: { "content-type": "application/json", origin: gb },
        body: JSON.stringify({ idempotencyKey: "gateway-key-0001", target: "main", text: "hello" }),
      });
      expect(cmd.status).toBe(201);
      expect((await cmd.json()).command.actor).toBe("gateway");
      expect(sent).toEqual(["main"]);

      // Per-host MCP through the gateway, using the unmodified SDK client with no credentials.
      const client = new Client({ name: "gw-test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${gb}/api/hosts/real/mcp`)));
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("request_gate");
      await client.close();

      // A browser-origin MCP post from elsewhere is refused before it reaches the host.
      const evil = await fetch(`${gb}/api/hosts/real/mcp`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
      expect(evil.status).toBe(403);
    } finally {
      g.stop(true);
      host.stop(true);
    }
  });
});
