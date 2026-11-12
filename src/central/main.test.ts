import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { centralConfig, startCentral } from "./main.ts";
import { HostAgentClient, type HostSocket } from "../host-agent/client.ts";

const token = "test-only-token";
const credentials = JSON.stringify([{ tokenHash: createHash("sha256").update(token).digest("hex"), principal: { name: "test", role: "operator" } }]);
const env = { CENTRAL_DATABASE_URL: "postgres://example.invalid/test", CENTRAL_CREDENTIALS_FILE: "fixture.json", CENTRAL_PORT: "4567" };

function fixture(text = credentials, failQuery = false, identities: { principalId: string; name: string; hostId: string; session: string; retired?: boolean }[] = []) {
  const queries: string[] = [];
  let closes = 0, stops = 0;
  let listener: Parameters<NonNullable<Parameters<typeof startCentral>[1]>["serve"]>[0] | undefined;
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    queries.push(query);
    if (failQuery) throw new Error("secret database url");
    if (query.includes("SELECT principal_id FROM central_supervisor_identities_v2")) {
      return identities.some((identity) => !identity.retired && [identity.principalId, identity.name, identity.hostId, identity.session].every((value, index) => value === values[index])) ? [{ principal_id: values[0] }] : [];
    }
    return [];
  }, { close: async () => { closes++; } }) as unknown as SQL;
  const deps = {
    readCredentials: async (_path: string) => text,
    createSql: (_url: string) => sql,
    serve: (options: NonNullable<typeof listener>) => { listener = options; return { async stop(_closeActiveConnections?: boolean) { stops++; } }; },
  };
  return { deps, queries, get listener() { return listener; }, get closes() { return closes; }, get stops() { return stops; } };
}

describe("local central startup", () => {
  test("requires explicit configuration and rejects any nonlocal bind", () => {
    expect(() => centralConfig({})).toThrow();
    expect(() => centralConfig({ ...env, CENTRAL_DATABASE_URL: "" })).toThrow();
    for (const hostname of ["", "localhost", "::1", "0.0.0.0", "192.0.2.1"]) {
      expect(() => centralConfig({ ...env, CENTRAL_HOST: hostname })).toThrow();
    }
    for (const port of ["0", "65536", "1x", "-1"]) expect(() => centralConfig({ ...env, CENTRAL_PORT: port })).toThrow();
  });
  test("initializes both stores, binds only IPv4 loopback and never reconciles", async () => {
    const f = fixture();
    const running = await startCentral(env, f.deps);
    expect(f.listener?.hostname).toBe("127.0.0.1");
    expect(f.listener?.port).toBe(4567);
    expect(f.queries.some((query) => query.includes("central_commands"))).toBe(true);
    expect(f.queries.some((query) => query.includes("central_requests"))).toBe(true);
    expect(f.queries.some((query) => query.includes("CREATE TABLE IF NOT EXISTS central_supervisor_identities_v2"))).toBe(true);
    expect(f.queries.some((query) => query.includes("SELECT principal_id FROM central_supervisor_identities_v2"))).toBe(false);
    expect(f.queries.some((query) => /UPDATE central_commands/.test(query))).toBe(false);
    const response = await f.listener!.fetch(new Request("http://127.0.0.1:4567/unknown", { headers: { authorization: `Bearer ${token}` } }), {} as never);
    expect(response?.status).toBe(404);
    await running.stop();
    expect(f.stops).toBe(1);
    expect(f.closes).toBe(1);
  });
  test("mounts an inventory-only host socket on the real loopback listener", async () => {
    const hostToken = "test-host-token";
    const hostCredentials = JSON.stringify([
      JSON.parse(credentials)[0],
      { tokenHash: createHash("sha256").update(hostToken).digest("hex"), principal: { name: "host", role: "host", hostId: "host-a" } },
    ]);
    const f = fixture(hostCredentials);
    let port = 0;
    const running = await startCentral(env, { ...f.deps, serve: (options) => {
      const server = Bun.serve({ ...options, port: 0 });
      port = server.port!;
      return server;
    } });
    let socket: WebSocket | undefined;
    try {
      const url = `http://127.0.0.1:${port}/api/host/socket`;
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
      expect((await fetch(url, { headers: { authorization: `Bearer ${hostToken}`, origin: "http://127.0.0.1" } })).status).toBe(403);
      expect((await fetch(`${url}?unexpected=1`, { headers: { authorization: `Bearer ${hostToken}` } })).status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${port}/unknown`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      const BunSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
      socket = new BunSocket(url.replace("http:", "ws:"), { headers: { authorization: `Bearer ${hostToken}` } });
      await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
      const hosts = async (bearer: string) => fetch(`http://127.0.0.1:${port}/api/hosts`, { headers: { authorization: `Bearer ${bearer}` } });
      expect((await hosts(hostToken)).status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${port}/api/hosts`)).status).toBe(401);
      expect(await (await hosts(token)).json()).toEqual({ hosts: [{ hostId: "host-a", sessions: null }] });
      const messages: unknown[] = [];
      socket.onmessage = (event) => messages.push(event.data);
      const queriesBefore = f.queries.length;
      socket.send(JSON.stringify({ version: 1, type: "inventory", hostId: "host-a", sessions: ["supervisor"] }));
      await Bun.sleep(30);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(await (await hosts(token)).json()).toEqual({ hosts: [{ hostId: "host-a", sessions: ["supervisor"] }] });
      expect(f.queries).toHaveLength(queriesBefore);
      expect(messages).toEqual([]);
      const closed = new Promise<number>((resolve) => { socket!.onclose = (event) => resolve(event.code); });
      socket.send(JSON.stringify({ version: 1, type: "receipt", hostId: "host-a", commandId: "c", attemptId: "a", status: "delivered" }));
      expect(await closed).toBe(1008);
      expect(await (await hosts(token)).json()).toEqual({ hosts: [] });
      expect(f.queries).toHaveLength(queriesBefore);
      expect(messages).toEqual([]);
    } finally {
      socket?.close();
      await running.stop();
    }
  });
  test("client seam republishes inventory after a real loopback reconnect", async () => {
    const hostToken = "inventory-host-token";
    const f = fixture(JSON.stringify([JSON.parse(credentials)[0], { tokenHash: createHash("sha256").update(hostToken).digest("hex"), principal: { name: "host", role: "host", hostId: "host-a" } }]));
    let port = 0;
    const running = await startCentral(env, { ...f.deps, serve: (options) => { const server = Bun.serve({ ...options, port: 0 }); port = server.port!; return server; } });
    let latestSocket: WebSocket | undefined;
    let timer: (() => void) | undefined;
    let inventory = ["first"];
    const client = new HostAgentClient({
      url: `ws://127.0.0.1:${port}/api/host/socket`, hostId: "host-a", token: hostToken, allowLoopbackWsForTests: true,
      socketFactory: (url, options) => { const Socket = WebSocket as unknown as new (url: string, options: { headers: { Authorization: string } }) => WebSocket; latestSocket = new Socket(url, options); return latestSocket as unknown as HostSocket; },
      execute: async () => { throw new Error("dispatch disabled"); }, inventory: () => inventory,
      setTimer: (callback) => { timer = callback; return callback; }, clearTimer: () => { timer = undefined; },
    });
    const hosts = async () => (await (await fetch(`http://127.0.0.1:${port}/api/hosts`, { headers: { authorization: `Bearer ${token}` } })).json()).hosts;
    const waitFor = async (predicate: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await Bun.sleep(5); } throw new Error("condition not reached"); };
    try {
      client.start();
      await waitFor(async () => JSON.stringify(await hosts()) === JSON.stringify([{ hostId: "host-a", sessions: ["first"] }]));
      latestSocket!.close();
      await waitFor(async () => !!timer && (await hosts()).length === 0);
      inventory = ["second"];
      const reconnect = timer!; timer = undefined; reconnect();
      await waitFor(async () => JSON.stringify(await hosts()) === JSON.stringify([{ hostId: "host-a", sessions: ["second"] }]));
      client.stop();
      await waitFor(async () => (await hosts()).length === 0);
    } finally { client.stop(); await running.stop(); }
  });
  test("closes open sockets and waits for in-flight handlers before the pool", async () => {
    const hostToken = "shutdown-host-token";
    const f = fixture(JSON.stringify([
      JSON.parse(credentials)[0],
      { tokenHash: createHash("sha256").update(hostToken).digest("hex"), principal: { name: "host", role: "host", hostId: "host-a" } },
    ]));
    let releaseQuery!: () => void;
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => { queryStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    let closed = false;
    const baseSql = f.deps.createSql("");
    const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (/FROM central_commands\s+WHERE\b/.test(strings.join("?"))) {
        queryStarted();
        await gate;
        expect(closed).toBe(false);
        return [];
      }
      return baseSql(strings, ...values);
    }, { close: async () => { closed = true; } }) as unknown as SQL;
    let port = 0;
    // Short grace: an open host socket holds a graceful stop until the deadline force-closes it.
    const running = await startCentral(env, { ...f.deps, createSql: () => sql, serve: (options) => {
      const server = Bun.serve({ ...options, port: 0 });
      port = server.port!;
      return server;
    } }, { shutdownGraceMs: 100 });
    const BunSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    const socket = new BunSocket(`ws://127.0.0.1:${port}/api/host/socket`, { headers: { authorization: `Bearer ${hostToken}` } });
    let stop: Promise<void> | undefined;
    try {
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
      const socketClosed = new Promise<void>((resolve) => { socket.onclose = () => resolve(); });
      const request = fetch(`http://127.0.0.1:${port}/api/commands`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
      await started;
      stop = running.stop();
      await socketClosed;
      expect(closed).toBe(false);
      releaseQuery();
      await stop;
      expect(closed).toBe(true);
      await request;
    } finally {
      releaseQuery();
      socket.close();
      await (stop ?? running.stop());
    }
  });
  test("requires a supervisor principal ID in credentials at startup", async () => {
    const supervisor = { name: "supervisor", role: "supervisor", principalId: "supervisor-id", hostId: "host-a", session: "session-a" };
    const tokenHash = createHash("sha256").update("supervisor-token").digest("hex");
    const valid = fixture(JSON.stringify([{ tokenHash, principal: supervisor }]), false, [supervisor]);
    const running = await startCentral(env, valid.deps);
    expect(valid.listener).toBeDefined();
    expect(valid.queries.some((query) => query.includes("SELECT principal_id FROM central_supervisor_identities_v2"))).toBe(true);
    expect(valid.queries.some((query) => query.includes("INSERT INTO central_supervisor_identities_v2"))).toBe(false);
    const lookupsBefore = valid.queries.filter((query) => query.includes("SELECT principal_id FROM central_supervisor_identities_v2")).length;
    await valid.listener!.fetch(new Request("http://127.0.0.1:4567/unknown", { headers: { authorization: "Bearer supervisor-token" } }), {} as never);
    expect(valid.queries.filter((query) => query.includes("SELECT principal_id FROM central_supervisor_identities_v2"))).toHaveLength(lookupsBefore + 1);
    await running.stop();

    const { principalId: _, ...missingId } = supervisor;
    const invalid = fixture(JSON.stringify([{ tokenHash, principal: missingId }]));
    await expect(startCentral(env, invalid.deps)).rejects.toThrow("invalid or unreadable central credentials file");
    expect(invalid.queries).toHaveLength(0);
    expect(invalid.listener).toBeUndefined();
  });
  test("requires every supervisor tuple to be pre-enrolled and active before listening", async () => {
    const supervisor = { name: "supervisor", role: "supervisor", principalId: "supervisor-id", hostId: "host-a", session: "session-a" };
    const text = JSON.stringify([{ tokenHash: "a".repeat(64), principal: supervisor }]);
    for (const identities of [[], [{ ...supervisor, retired: true }], [{ ...supervisor, session: "different" }]]) {
      const f = fixture(text, false, identities);
      await expect(startCentral(env, f.deps)).rejects.toThrow("central startup failed");
      expect(f.listener).toBeUndefined();
      expect(f.closes).toBe(1);
      expect(f.queries.some((query) => query.includes("INSERT INTO central_supervisor_identities_v2"))).toBe(false);
    }
  });
  test("checks all configured supervisors before opening the listener", async () => {
    const first = { name: "first", role: "supervisor", principalId: "first-id", hostId: "host-a", session: "session-a" };
    const second = { name: "second", role: "supervisor", principalId: "second-id", hostId: "host-b", session: "session-b" };
    const text = JSON.stringify([{ tokenHash: "a".repeat(64), principal: first }, { tokenHash: "b".repeat(64), principal: second }]);
    const missing = fixture(text, false, [first]);
    await expect(startCentral(env, missing.deps)).rejects.toThrow("central startup failed");
    expect(missing.listener).toBeUndefined();
    expect(missing.closes).toBe(1);
    const valid = fixture(text, false, [first, second]);
    const running = await startCentral(env, valid.deps);
    expect(valid.queries.filter((query) => query.includes("SELECT principal_id FROM central_supervisor_identities_v2"))).toHaveLength(2);
    await running.stop();
  });
  test("fails closed and cleans up if the identity lookup errors", async () => {
    const supervisor = { name: "supervisor", role: "supervisor", principalId: "supervisor-id", hostId: "host-a", session: "session-a" };
    const f = fixture(JSON.stringify([{ tokenHash: "a".repeat(64), principal: supervisor }]));
    const base = f.deps.createSql("");
    const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("SELECT principal_id FROM central_supervisor_identities_v2")) throw new Error("secret lookup error");
      return base(strings, ...values);
    }, { close: () => base.close() }) as unknown as SQL;
    await expect(startCentral(env, { ...f.deps, createSql: () => sql })).rejects.toThrow("central startup failed");
    expect(f.listener).toBeUndefined();
    expect(f.closes).toBe(1);
  });
  test("rejects raw tokens, malformed JSON and unknown credential fields without leaking content", async () => {
    for (const text of ["secret invalid json", JSON.stringify([{ tokenHash: token, principal: { name: "test", role: "operator" } }]), JSON.stringify([{ tokenHash: "a".repeat(64), token: "secret", principal: { name: "test", role: "operator" } }])]) {
      const f = fixture(text);
      await expect(startCentral(env, f.deps)).rejects.toThrow("invalid or unreadable central credentials file");
      expect(f.queries).toHaveLength(0);
    }
  });
  test("sanitizes startup failures and closes the pool", async () => {
    const f = fixture(credentials, true);
    await expect(startCentral(env, f.deps)).rejects.toThrow("central startup failed");
    expect(f.closes).toBe(1);
    expect(f.listener).toBeUndefined();
  });
});
