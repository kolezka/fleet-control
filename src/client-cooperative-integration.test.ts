import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGatewayConfig, startGateway } from "./client-gateway.ts";
import { CommandError } from "./domain/commands.ts";
import { CentralAuth } from "./central/auth.ts";
import type { CentralCommand } from "./central/domain/commands.ts";
import type { CooperativeClaims } from "./central/data/cooperative-claims.ts";
import type { CooperativeLifecycle } from "./central/data/cooperative-lifecycle.ts";
import type { CooperativeStatus, CooperativeInspectionResult } from "./central/domain/cooperative.ts";
import { createCooperativeCentralApp, type CooperativeCommands } from "./central/cooperative-server.ts";

// Synthetic stores exercise real HTTP/auth/gateway wiring, not PostgreSQL or real agents.
// Fixture updates below are not evidence of execution or incarnation fencing.
const centralToken = "synthetic-central-operator-token";
const hostTokens = ["synthetic-host-alpha-token", "synthetic-host-beta-token", "synthetic-host-legacy-token"];
const incarnationId = "00000000-0000-4000-8000-000000000001";
const at = "2026-11-13T12:00:00.000Z";
type Seen = { path: string; authorization: string | null; origin: string | null; cookie: string | null };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "client-cooperative-integration-"));
  const records = new Map<string, CooperativeInspectionResult>();
  const centralSeen: Seen[] = [];
  const hostSeen: (Seen & { host: number })[] = [];
  const logs: string[] = [];
  const commands: CooperativeCommands = {
    async submitBounded(input) {
      const existing = [...records.values()].find(({ command }) => command.idempotencyKey === input.idempotencyKey);
      if (existing) {
        for (const key of ["hostId", "target", "actor", "text"] as const) {
          if (existing.command[key] !== input[key]) throw new CommandError("conflict", "different intent");
        }
        return { command: existing.command, created: false };
      }
      const command: CentralCommand = { ...input, id: "cmd-" + (records.size + 1), status: "queued", createdAt: at, updatedAt: at };
      records.set(command.id, { command, claim: null, events: [], nextCursor: null });
      return { command, created: true };
    },
    async getBounded(id) {
      const record = records.get(id);
      if (!record) throw new CommandError("not_found", "command not found");
      return record.command;
    },
    async listBounded(status, scope, options = {}) {
      const matching = [...records.values()].map(({ command }) => command).filter((command) =>
        (!status || command.status === status) && command.hostId === scope?.hostId && command.target === scope?.target);
      const offset = options.cursor ? Number(Buffer.from(options.cursor, "base64url").toString()) : 0;
      const end = offset + (options.limit ?? 4);
      return { commands: matching.slice(offset, end), nextCursor: matching.length > end ? Buffer.from(String(end)).toString("base64url") : null };
    },
  };
  const auth = new CentralAuth([{ tokenHash: createHash("sha256").update(centralToken).digest("hex"), principal: { name: "browser-operator", role: "operator" } }]);
  const app = createCooperativeCentralApp({
    auth, commands, identities: { async matches() { return false; } },
    claims: { async claim() { throw new Error("synthetic fixture has no agent"); } } as unknown as CooperativeClaims,
    lifecycle: { async report() { throw new Error("synthetic fixture has no agent"); } } as unknown as CooperativeLifecycle,
    inspection: {
      async inspectBounded(id, options) {
        const record = records.get(id);
        if (!record) return null;
        const remaining = record.events.filter((event) => BigInt(event.seq) > BigInt(options.cursor ?? "0"));
        const events = remaining.slice(0, options.limit);
        return { ...record, events, nextCursor: remaining.length > events.length ? events.at(-1)!.seq : null };
      },
    },
  });
  const seen = (req: Request): Seen => ({ path: new URL(req.url).pathname + new URL(req.url).search, authorization: req.headers.get("authorization"), origin: req.headers.get("origin"), cookie: req.headers.get("cookie") });
  const central = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { centralSeen.push(seen(req)); return app.fetch(req); } });
  const hosts = hostTokens.map((token, host) => Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      hostSeen.push({ ...seen(req), host });
      if (req.headers.get("authorization") !== "Bearer " + token) return Response.json({ error: "unauthorized" }, { status: 401 });
      const path = new URL(req.url).pathname;
      if (path === "/api/sessions") return Response.json({ sessions: [{ name: "main", label: "synthetic host " + host }] });
      if (path === "/api/commands" && host === 2) return Response.json({ commands: [{ id: "legacy-command", status: "delivered" }] });
      return Response.json({ error: "unexpected host control request" }, { status: 500 });
    },
  }));
  let gateway: ReturnType<typeof startGateway> | undefined;
  const stop = () => {
    gateway?.stop(true);
    central.stop(true);
    for (const host of hosts) host.stop(true);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    writeFileSync(join(dir, "operator.token"), centralToken, { mode: 0o600 });
    const configPath = join(dir, "client.json");
    for (const [index, token] of hostTokens.entries()) writeFileSync(join(dir, "host-" + index + ".token"), token, { mode: 0o600 });
    writeFileSync(configPath, JSON.stringify({
      central: { url: "http://127.0.0.1:" + central.port, tokenFile: "operator.token" },
      hosts: hosts.map((host, index) => ({
        id: ["alpha", "beta", "legacy"][index], name: "Synthetic host " + index, url: "http://127.0.0.1:" + host.port, tokenFile: "host-" + index + ".token",
        ...(index < 2 ? { supervisor: { hostId: "central-host-" + index, session: "supervisor" } } : {}),
      })),
    }));
    const config = await loadGatewayConfig(configPath);
    gateway = startGateway(config, { port: 0, log: (line) => logs.push(line) });
    const origin = "http://127.0.0.1:" + gateway.port;
    const responses: string[] = [];
    const browser = async (path: string, body?: object) => {
      const response = await fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie: "synthetic-browser-cookie=private", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      responses.push(text, JSON.stringify([...response.headers]));
      return { status: response.status, body: JSON.parse(text) };
    };
    const reserve = (id: string) => {
      const record = records.get(id)!;
      record.command.status = "claimed";
      record.claim = { incarnationId, incarnationActive: true, settled: false, requestId: "claim-" + id, createdAt: at };
    };
    const report = (id: string, status: CooperativeStatus) => {
      const record = records.get(id)!;
      record.events.push({ seq: String(record.events.length + 1), requestId: status + "-" + id, status, detail: "synthetic " + status, at });
    };
    return { browser, records, reserve, report, centralSeen, hostSeen, responses, logs, config, stop };
  } catch (error) { stop(); throw error; }
}

const submit = (key: string, text = "Inspect synthetic fixture only") => ({ target: "supervisor", text, idempotencyKey: key });
const commandPath = (host: string, id = "") => "/api/hosts/" + host + "/commands" + (id ? "/" + id : "");

test("synthetic browser retry and inspection separate reservation from lifecycle", async () => {
  const f = await fixture();
  try {
    const created = await f.browser(commandPath("alpha"), submit("manual-retry"));
    expect(created.status).toBe(201);
    expect(created.body.command).toMatchObject({ hostId: "central-host-0", target: "supervisor", actor: "browser-operator", status: "queued" });
    const id = created.body.command.id;
    const path = commandPath("alpha", id);
    const retry = await f.browser(commandPath("alpha"), submit("manual-retry"));
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ created: false, command: { id } });
    expect(f.records.size).toBe(1);
    const queued = await f.browser(path + "/cooperative?limit=4");
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({ command: { status: "queued" }, claim: null, events: [] });
    f.reserve(id);
    const reserved = await f.browser(path + "/cooperative");
    expect(reserved.body).toMatchObject({ command: { status: "claimed" }, claim: { incarnationActive: true, settled: false }, events: [] });
    for (const status of ["accepted", "running", "completed"] as const) {
      f.report(id, status);
      const inspection = await f.browser(path + "/cooperative?limit=4");
      expect(inspection.status).toBe(200);
      expect(inspection.body.command.status).toBe("claimed");
      expect(inspection.body.events.at(-1)).toMatchObject({ status, detail: "synthetic " + status });
    }
    const page = await f.browser(path + "/cooperative?limit=2");
    expect(page.body.events.map((event: { status: string }) => event.status)).toEqual(["accepted", "running"]);
    expect(page.body.nextCursor).toBe("2");
    const tail = await f.browser(path + "/cooperative?limit=2&cursor=" + page.body.nextCursor);
    expect(tail.body.events.map((event: { status: string }) => event.status)).toEqual(["completed"]);
    expect(tail.body.nextCursor).toBeNull();
    const command = await f.browser(path);
    expect(command.status).toBe(200);
    expect(command.body.command.status).toBe("claimed");
    const listing = await f.browser(commandPath("alpha") + "?limit=4");
    expect(listing.status).toBe(200);
    expect(listing.body.commands.map((command: { id: string }) => command.id)).toEqual([id]);
    expect(listing.body.commands[0].status).toBe("claimed");
    expect(f.hostSeen).toEqual([]);
    expect(f.centralSeen.length).toBeGreaterThan(0);
    for (const request of f.centralSeen) {
      expect(request.authorization).toBe("Bearer " + centralToken);
      expect(request.origin).toBeNull();
      expect(request.cookie).toBeNull();
      expect(request.path).not.toContain("/mcp");
    }
    const exposed = JSON.stringify([f.responses, f.logs, f.config]);
    for (const token of [centralToken, ...hostTokens]) expect(exposed).not.toContain(token);
  } finally { f.stop(); }
});

test("synthetic inactive claim stays inspectable without crossing host or session scope", async () => {
  const f = await fixture();
  try {
    const alpha = await f.browser(commandPath("alpha"), submit("alpha-only", "alpha instruction"));
    const beta = await f.browser(commandPath("beta"), submit("beta-only", "beta instruction"));
    expect(alpha.status).toBe(201);
    expect(beta.status).toBe(201);
    const id = alpha.body.command.id;
    f.reserve(id);
    f.report(id, "accepted");
    f.records.get(id)!.claim!.incarnationActive = false;
    const stale = await f.browser(commandPath("alpha", id) + "/cooperative");
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ command: { status: "claimed" }, claim: { incarnationActive: false, settled: false } });
    expect(stale.body.events.map((event: { status: string }) => event.status)).toEqual(["accepted"]);
    for (const suffix of ["", "/cooperative"]) {
      const denied = await f.browser(commandPath("beta", id) + suffix);
      expect([403, 404]).toContain(denied.status);
      expect(JSON.stringify(denied.body)).not.toContain("alpha instruction");
    }
    const betaList = await f.browser(commandPath("beta") + "?limit=4");
    expect(betaList.body.commands.map((command: { id: string }) => command.id)).toEqual([beta.body.command.id]);
    const wrongSession = await f.browser(commandPath("alpha"), { ...submit("wrong-session"), target: "other-session" });
    expect(wrongSession.status).toBeGreaterThanOrEqual(400);
    expect(f.records.size).toBe(2);
    const foreign = await f.browser(commandPath("alpha") + "?hostId=central-host-1&target=supervisor");
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(f.hostSeen).toEqual([]);
  } finally { f.stop(); }
});

test("synthetic command listing preserves bounded cursor pages within one mapped scope", async () => {
  const f = await fixture();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const result = await f.browser(commandPath("alpha"), submit("page-" + index));
      expect(result.status).toBe(201);
      ids.push(result.body.command.id);
    }
    const first = await f.browser(commandPath("alpha") + "?limit=4");
    expect(first.status).toBe(200);
    expect(first.body.commands.map((command: { id: string }) => command.id)).toEqual(ids.slice(0, 4));
    expect(typeof first.body.nextCursor).toBe("string");
    const second = await f.browser(commandPath("alpha") + "?limit=4&cursor=" + first.body.nextCursor);
    expect(second.status).toBe(200);
    expect(second.body.commands.map((command: { id: string }) => command.id)).toEqual(ids.slice(4));
    expect(second.body.nextCursor).toBeNull();
    const oversized = await f.browser(commandPath("alpha") + "?limit=5");
    expect(oversized.status).toBe(400);
    expect(f.hostSeen).toEqual([]);
  } finally { f.stop(); }
});

test("mapped approvals and MCP fail closed while legacy sessions stay on host services", async () => {
  const f = await fixture();
  try {
    for (const [path, body] of [
      ["/api/hosts/alpha/requests", undefined],
      ["/api/hosts/alpha/requests/request-1/resolve", { decision: "approved" }],
      ["/api/hosts/alpha/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
    ] as const) {
      const denied = await f.browser(path, body);
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(denied.body.error).toBeDefined();
    }
    expect(f.centralSeen).toEqual([]);
    expect(f.hostSeen).toEqual([]);
    for (const host of ["alpha", "beta", "legacy"]) {
      const sessions = await f.browser("/api/hosts/" + host + "/sessions");
      expect(sessions.status).toBe(200);
      expect(sessions.body.sessions[0].name).toBe("main");
    }
    const legacy = await f.browser(commandPath("legacy"));
    expect(legacy.status).toBe(200);
    expect(legacy.body.commands[0]).toMatchObject({ id: "legacy-command", status: "delivered" });
    expect(f.hostSeen.map((request) => request.path)).toEqual(["/api/sessions", "/api/sessions", "/api/sessions", "/api/commands"]);
    for (const request of f.hostSeen) {
      expect(request.authorization).toBe("Bearer " + hostTokens[request.host]);
      expect(request.cookie).toBeNull();
    }
    expect(f.centralSeen).toEqual([]);
    for (const token of [centralToken, ...hostTokens]) expect(JSON.stringify([f.responses, f.logs])).not.toContain(token);
  } finally { f.stop(); }
});
