import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, chownSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Credentials, GatewayConfigError, loadGatewayConfig, parseGatewayConfig, startGateway, type GatewayOptions } from "./client-gateway.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const host = { id: "desktop", name: "Desktop", url: "https://host.example", tokenFile: "host.token" };
const supervisor = { hostId: "central-desktop", session: "main-supervisor" };
const central = { url: "https://central.example", tokenFile: "central.token" };
const config = () => ({ hosts: [{ ...host, supervisor }], central });

function diskConfig() {
  const dir = mkdtempSync(join(tmpdir(), "central-gateway-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "host.token"), "host-fixture-secret");
  writeFileSync(join(dir, "central.token"), "operator-fixture-secret", { mode: 0o600 });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config()));
  return { dir, path, token: join(dir, "central.token") };
}

describe("central configuration", () => {
  test("expands config without changing the legacy array contract", () => {
    expect(parseGatewayConfig({ hosts: [host] }, "/etc/fleet")).toEqual([{ id: host.id, name: host.name, origin: host.url, tokenFile: "/etc/fleet/host.token" }]);
    expect(parseGatewayConfig(config(), "/etc/fleet")[0]?.supervisor).toEqual(supervisor);
    expect(parseGatewayConfig({ ...config(), hosts: [host] }, "/etc/fleet")[0]?.supervisor).toBeUndefined();
  });
  test("requires explicit valid central and exact bounded mappings", () => {
    const invalid = [{ ...supervisor, session: "has space" }, { ...supervisor, session: "has/slash" }, { ...supervisor, hostId: "\ud800" }, { ...supervisor, session: "\ud800" }, null, {}, [], { ...supervisor, extra: true }, { ...supervisor, hostId: "" }, { ...supervisor, hostId: " padded" }, { ...supervisor, session: "x".repeat(257) }, { ...supervisor, session: "bad\u0000session" }];
    for (const mapping of invalid) expect(() => parseGatewayConfig({ ...config(), hosts: [{ ...host, supervisor: mapping }] }, "/")).toThrow(GatewayConfigError);
    expect(() => parseGatewayConfig({ hosts: [{ ...host, supervisor }] }, "/")).toThrow(/requires central/);
    for (const value of [null, {}, { ...central, extra: true }, { ...central, url: "http://192.0.2.1" }, { ...central, url: "https://central.example/path" }, { ...central, tokenFile: "" }]) expect(() => parseGatewayConfig({ ...config(), central: value }, "/")).toThrow(GatewayConfigError);
    expect(parseGatewayConfig({ ...config(), hosts: [{ ...host, supervisor: { hostId: "x".repeat(256), session: "s".repeat(256) } }] }, "/")).toHaveLength(1);
  });
  test("loads dedicated nonserializable credentials and rejects host token reuse", async () => {
    const fixture = diskConfig();
    const loaded = await loadGatewayConfig(fixture.path);
    expect(loaded.central?.credentials.bearer("operator")).toBe("operator-fixture-secret");
    expect(loaded.credentials.bearer(host.id)).toBe("host-fixture-secret");
    expect(JSON.stringify(loaded)).not.toContain("fixture-secret");
    expect(inspect(loaded)).not.toContain("fixture-secret");
    writeFileSync(fixture.token, "host-fixture-secret");
    await expect(loadGatewayConfig(fixture.path)).rejects.toThrow(/must not share/);
  });
  test("requires owned regular nonsymlink mode 0600 central token without echo", async () => {
    const fixture = diskConfig();
    chmodSync(fixture.token, 0o644);
    await expect(loadGatewayConfig(fixture.path)).rejects.toThrow(/0600/);
    chmodSync(fixture.token, 0o600);
    writeFileSync(fixture.token, "malformed secret content");
    const error = await loadGatewayConfig(fixture.path).catch((error: Error) => error);
    expect(String(error)).not.toContain("malformed secret content");
    const link = join(fixture.dir, "link.token");
    symlinkSync(fixture.token, link);
    writeFileSync(fixture.path, JSON.stringify({ ...config(), central: { ...central, tokenFile: "link.token" } }));
    await expect(loadGatewayConfig(fixture.path)).rejects.toThrow(/nonsymlink/);
    mkdirSync(join(fixture.dir, "directory.token"), { mode: 0o600 });
    writeFileSync(fixture.path, JSON.stringify({ ...config(), central: { ...central, tokenFile: "directory.token" } }));
    await expect(loadGatewayConfig(fixture.path)).rejects.toThrow(/regular/);
    if (process.getuid?.() === 0) {
      writeFileSync(fixture.path, JSON.stringify(config()));
      writeFileSync(fixture.token, "operator-fixture-secret");
      chownSync(fixture.token, 1, 1);
      await expect(loadGatewayConfig(fixture.path)).rejects.toThrow(/owned/);
    }
  });
});

type Seen = { url: URL; method: string; headers: Headers; body: string };
function harness(opts: GatewayOptions = {}) {
  const legacySeen: Seen[] = [], centralSeen: Seen[] = [], logs: string[] = [];
  const command = { id: "cmd-1", hostId: supervisor.hostId, target: supervisor.session, text: "synthetic work", status: "queued" };
  let respond = (seen: Seen): Response | Promise<Response> => {
    if (seen.url.pathname.endsWith("/cooperative")) return Response.json({ command, claim: null, events: [], nextCursor: null });
    if (seen.method === "POST") return Response.json({ command: { ...command, ...JSON.parse(seen.body) }, created: true }, { status: 201 });
    if (seen.url.pathname === "/api/commands" && seen.method === "GET") return Response.json({ commands: [command], nextCursor: "next-page" });
    return Response.json({ command, created: true }, { status: seen.method === "POST" ? 201 : 200 });
  };
  function server(seen: Seen[], central: boolean) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const record = { url: new URL(req.url), method: req.method, headers: req.headers, body: req.method === "GET" ? "" : await req.text() };
      seen.push(record);
      if (central) return respond(record);
      return Response.json({ legacy: true, sessions: [] });
    } });
    cleanup.push(() => server.stop(true));
    return `http://127.0.0.1:${server.port}`;
  }
  const legacyOrigin = server(legacySeen, false), centralOrigin = server(centralSeen, true);
  const gateway = startGateway({ hosts: [{ id: "desktop", name: "Desktop", origin: legacyOrigin, supervisor }, { id: "legacy", name: "Legacy", origin: legacyOrigin }, { id: "other", name: "Other", origin: legacyOrigin, supervisor: { hostId: "central-other", session: "other-session" } }], credentials: new Credentials(new Map([["desktop", "desktop-host-secret"], ["legacy", "legacy-host-secret"], ["other", "other-host-secret"]])), central: { origin: centralOrigin, credentials: new Credentials(new Map([["operator", "central-operator-secret"]])) } }, { port: 0, log: (line) => logs.push(line), ...opts });
  cleanup.push(() => gateway.stop(true));
  const origin = `http://127.0.0.1:${gateway.port}`;
  const call = (path: string, init: RequestInit = {}) => fetch(origin + "/api/hosts/" + path, init);
  const post = (body: unknown, path = "desktop/commands", headers: Record<string, string> = {}) => call(path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { call, post, origin, centralOrigin, legacyOrigin, centralSeen, legacySeen, command, logs, set respond(value: typeof respond) { respond = value; } };
}

describe("central gateway routing", () => {
  test("exposes mapping only and keeps terminal/session and unmapped hosts legacy", async () => {
    const h = harness();
    const response = await fetch(h.origin + "/api/hosts");
    const json = await response.json();
    expect(json.hosts[0]).toEqual({ id: "desktop", name: "Desktop", apiBase: "/api/hosts/desktop", supervisor });
    expect(json.hosts[1].supervisor).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain(h.centralOrigin);
    expect(JSON.stringify(json)).not.toContain("secret");
    await h.call("desktop/sessions"); await h.call("desktop/sessions/main/screen?lines=20"); await h.call("legacy/commands");
    expect(h.centralSeen).toHaveLength(0);
    expect(h.legacySeen.map((r) => r.url.pathname)).toEqual(["/api/sessions", "/api/sessions/main/screen", "/api/commands"]);
    expect(h.legacySeen[0]?.headers.get("origin")).toBe(h.legacyOrigin);
    expect(h.legacySeen[2]?.headers.get("authorization")).toBe("Bearer legacy-host-secret");
  });
  test("forces bounded host/session list scope and central-only auth without Origin", async () => {
    const h = harness();
    expect((await h.call("desktop/commands", { headers: { authorization: "Bearer browser-secret", cookie: "private=browser" } })).status).toBe(200);
    const seen = h.centralSeen[0]!;
    expect(Object.fromEntries(seen.url.searchParams)).toEqual({ hostId: supervisor.hostId, target: supervisor.session, limit: "4" });
    expect(seen.headers.get("authorization")).toBe("Bearer central-operator-secret");
    expect(seen.headers.get("origin")).toBeNull(); expect(seen.headers.get("cookie")).toBeNull();
    expect((await h.call("desktop/commands?limit=2&cursor=a%2Bb%3D")).status).toBe(200);
    expect(h.centralSeen[1]?.url.searchParams.get("cursor")).toBe("a+b=");
    expect(h.legacySeen).toHaveLength(0);
  });
  test("rejects unknown/duplicate/oversized queries before touching either upstream", async () => {
    const h = harness();
    for (const query of ["hostId=elsewhere", "target=other", "actor=operator", "limit=5", "limit=0", "limit=01", "limit=1&limit=2", "cursor=a&cursor=b", "cursor=", "cursor=" + "x".repeat(8193)]) expect((await h.call("desktop/commands?" + query)).status).toBe(400);
    expect((await h.call("desktop/commands/cmd-1?cursor=a")).status).toBe(400);
    expect((await h.call("desktop/commands/cmd-1/cooperative?x=1")).status).toBe(400);
    expect(h.centralSeen).toHaveLength(0); expect(h.legacySeen).toHaveLength(0);
  });
  test("forwards bounded event pages without putting pagination on the ownership read", async () => {
    const h = harness();
    expect((await h.call("desktop/commands/cmd-1/cooperative?limit=2&cursor=9223372036854775807")).status).toBe(200);
    expect(h.centralSeen.map(r => r.url.search)).toEqual(["", "?limit=2&cursor=9223372036854775807"]);
    h.centralSeen.length = 0;
    for (const query of ["limit=5", "limit=01", "cursor=-1", "cursor=01", "cursor=9223372036854775808", "cursor=abc", "cursor=1&cursor=2"]) expect((await h.call("desktop/commands/cmd-1/cooperative?" + query)).status).toBe(400);
    expect(h.centralSeen).toHaveLength(0);
    expect(h.legacySeen).toHaveLength(0);
  });
  test("accepts exactly target/text/idempotencyKey and injects only configured host", async () => {
    const h = harness(); const body = { target: supervisor.session, text: "synthetic request", idempotencyKey: "intent-1" };
    expect((await h.post(body)).status).toBe(201);
    expect(JSON.parse(h.centralSeen[0]!.body)).toEqual({ ...body, hostId: supervisor.hostId });
    expect(h.centralSeen[0]?.headers.get("origin")).toBeNull();
    for (const patch of [{ hostId: "central-other" }, { actor: "fake" }, { extra: true }, { target: "other-session" }, { text: "" }, { idempotencyKey: "" }]) expect((await h.post({ ...body, ...patch })).status).toBe(400);
    expect((await h.post(body, "desktop/commands?hostId=other")).status).toBe(400);
    expect((await h.call("desktop/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(403);
    expect((await h.post(body, "desktop/commands", { origin: "https://foreign.example" })).status).toBe(403);
    expect(h.centralSeen).toHaveLength(1); expect(h.legacySeen).toHaveLength(0);
  });
  test("checks command ownership before get or inspection and denies cross-host/session", async () => {
    const h = harness();
    expect((await h.call("desktop/commands/cmd-1")).status).toBe(200);
    expect((await h.call("desktop/commands/cmd-1/cooperative")).status).toBe(200);
    expect(h.centralSeen.map((r) => r.url.pathname)).toEqual(["/api/commands/cmd-1", "/api/commands/cmd-1", "/api/commands/cmd-1/cooperative"]);
    h.centralSeen.length = 0;
    expect((await h.call("other/commands/cmd-1/cooperative")).status).toBe(403);
    expect(h.centralSeen.map((r) => r.url.pathname)).toEqual(["/api/commands/cmd-1"]);
    h.command.target = "wrong-session";
    expect((await h.call("desktop/commands/cmd-1")).status).toBe(403);
    expect(h.legacySeen).toHaveLength(0);
  });
  test("rejects final GET with a different command id in the same scope", async () => {
    const h = harness();
    h.respond = () => Response.json({ command: { ...h.command, id: "cmd-other" } });
    expect((await h.call("desktop/commands/cmd-1")).status).toBe(502);
    expect(h.centralSeen).toHaveLength(1); expect(h.legacySeen).toHaveLength(0);
  });
  for (const patch of [{ hostId: "foreign" }, { target: "foreign" }, { text: "different intent" }, { idempotencyKey: "other-intent" }, { id: null }]) {
    test("rejects mismatched successful POST " + JSON.stringify(patch), async () => {
      const h = harness();
      const input = { target: supervisor.session, text: "synthetic request", idempotencyKey: "intent-1" };
      h.respond = () => Response.json({ command: { ...h.command, ...input, ...patch }, created: true }, { status: 201 });
      const response = await h.post(input);
      expect(response.status).toBe(502);
      expect((await response.json()).error.outcome).toBe("unknown");
      expect(h.centralSeen).toHaveLength(1); expect(h.legacySeen).toHaveLength(0);
    });
  }
  const event = { seq: "9223372036854775806", requestId: "report-1", status: "accepted", detail: "synthetic detail", at: "2026-11-13T12:00:00.000Z" };
  const claim = { incarnationId: "incarnation-1", incarnationActive: false, settled: false, requestId: "claim-1", createdAt: event.at };
  const invalidInspection = [
    { command: { hostId: "foreign", target: supervisor.session, id: "cmd-1" } },
    { command: { hostId: supervisor.hostId, target: "foreign", id: "cmd-1" } },
    { command: { hostId: supervisor.hostId, target: supervisor.session, id: "other" } },
    { command: null }, { events: null }, { events: Array(5).fill(event) },
    ...[{ seq: "01" }, { seq: "9223372036854775808" }, { seq: 1 }, { status: "claimed" }, { detail: null }, { detail: "x".repeat(65537) }, { requestId: "" }, { at: "not-a-date" }].map(patch => ({ events: [{ ...event, ...patch }] })),
    { claim: {} }, { claim: { ...claim, incarnationActive: "false" } }, { claim: { ...claim, settled: null } }, { claim: { ...claim, requestId: 1 } }, { claim: { ...claim, createdAt: "bad" } },
    { nextCursor: "01" }, { nextCursor: event.seq }, { nextCursor: "9223372036854775808" },
    { events: [event], nextCursor: "1" }, { events: [event, event] },
  ];
  for (const [index, patch] of invalidInspection.entries()) {
    test("rejects hostile final inspection after valid ownership read " + index, async () => {
      const h = harness();
      h.respond = seen => Response.json(seen.url.pathname.endsWith("/cooperative") ? { command: h.command, claim: null, events: [], nextCursor: null, ...patch } : { command: h.command });
      expect((await h.call("desktop/commands/cmd-1/cooperative")).status).toBe(502);
      expect(h.centralSeen).toHaveLength(2); expect(h.legacySeen).toHaveLength(0);
    });
  }
  test("validates inspection event limit, cursor ordering and typed claim", async () => {
    const h = harness();
    h.respond = seen => Response.json(seen.url.pathname.endsWith("/cooperative") ? { command: h.command, claim, events: [event], nextCursor: event.seq } : { command: h.command });
    expect((await h.call("desktop/commands/cmd-1/cooperative?limit=1&cursor=9223372036854775805")).status).toBe(200);
    expect((await h.call("desktop/commands/cmd-1/cooperative?limit=1&cursor=" + event.seq)).status).toBe(502);
    h.respond = seen => Response.json(seen.url.pathname.endsWith("/cooperative") ? { command: h.command, claim, events: [{ ...event, seq: "1" }, event], nextCursor: null } : { command: h.command });
    expect((await h.call("desktop/commands/cmd-1/cooperative?limit=1")).status).toBe(502);
    expect(h.legacySeen).toHaveLength(0);
  });
  test("legacy request/MCP surfaces fail explicitly without fallback for mapped hosts", async () => {
    const h = harness();
    for (const response of [await h.call("desktop/requests"), await h.post({}, "desktop/requests/request-1/resolve"), await h.post({}, "desktop/mcp")]) { expect(response.status).toBe(501); expect((await response.json()).error.kind).toBe("unsupported"); }
    expect((await h.call("legacy/commands/cmd-1/cooperative")).status).toBe(404);
    expect(h.centralSeen).toHaveLength(0); expect(h.legacySeen).toHaveLength(0);
  });
  test("bounds request/response bodies and masks upstream errors and secrets", async () => {
    const h = harness({ maxRequestBytes: 1024, maxResponseBytes: 1024 });
    expect((await h.post({ target: supervisor.session, text: "x".repeat(1025), idempotencyKey: "intent" })).status).toBe(413);
    expect(h.centralSeen).toHaveLength(0);
    h.respond = () => new Response("x".repeat(2048), { headers: { "content-type": "application/json" } });
    expect((await h.call("desktop/commands")).status).toBe(502);
    for (const status of [400, 401, 403, 409, 500]) {
      h.respond = () => Response.json({ error: { kind: "secret", message: "central-operator-secret" } }, { status });
      const response = await h.call("desktop/commands");
      expect(await response.text()).not.toContain("central-operator-secret");
    }
    h.respond = () => Response.json({ commands: [{ text: "desktop-host-secret" }] });
    expect((await h.call("desktop/commands")).status).toBe(502);
    expect(h.legacySeen).toHaveLength(0);
    expect(h.logs.join(" ")).not.toContain("secret");
  });
  test("rejects malformed or foreign command pages and encoded credential leaks", async () => {
    const h = harness();
    for (const body of [{ commands: [{ ...h.command, hostId: "foreign" }], nextCursor: null }, { commands: Array(5).fill(h.command), nextCursor: null }, { commands: [], nextCursor: "x".repeat(8193) }]) {
      h.respond = () => Response.json(body);
      expect((await h.call("desktop/commands")).status).toBe(502);
    }
    h.respond = () => new Response("not JSON", { headers: { "content-type": "application/json" } });
    expect((await h.call("desktop/commands")).status).toBe(502);
    h.respond = () => new Response(JSON.stringify({ commands: [], nextCursor: "central-operator-secret" }).replace("central", "\\u0063entral"), { headers: { "content-type": "application/json" } });
    expect((await h.call("desktop/commands")).status).toBe(502);
    expect(h.legacySeen).toHaveLength(0);
  });
  test("rejects redirects without following or falling back and marks unknown writes", async () => {
    const h = harness();
    h.respond = () => new Response(null, { status: 307, headers: { location: h.legacyOrigin + "/api/commands" } });
    const response = await h.post({ target: supervisor.session, text: "synthetic", idempotencyKey: "intent" });
    expect(response.status).toBe(502); expect((await response.json()).error.outcome).toBe("unknown");
    expect(h.centralSeen).toHaveLength(1); expect(h.legacySeen).toHaveLength(0);
  });
  test("times out unknown writes once without retry or legacy fallback", async () => {
    const h = harness({ timeoutMs: 25 });
    h.respond = async () => { await Bun.sleep(120); return Response.json({ command: h.command }); };
    const response = await h.post({ target: supervisor.session, text: "synthetic", idempotencyKey: "intent" });
    expect(response.status).toBe(504); expect((await response.json()).error.outcome).toBe("unknown");
    await Bun.sleep(150);
    expect(h.centralSeen).toHaveLength(1); expect(h.legacySeen).toHaveLength(0);
  });
});
