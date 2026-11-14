import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { createCentralApp, assertSafeCentralBind } from "./server.ts";
import { CommandError } from "../data/commands.ts";
import type { CentralMcpCommands } from "./mcp.ts";
import type { CentralRequests } from "./data/requests.ts";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const auth = new CentralAuth([
  { tokenHash: hash("operator"), principal: { name: "alice", role: "operator" } },
  { tokenHash: hash("host"), principal: { name: "host", role: "host", hostId: "h1" } },
  { tokenHash: hash("supervisor"), principal: { name: "supervisor", role: "supervisor", principalId: "supervisor-id", hostId: "h1", session: "s1" } },
]);
function fixture(requests?: CentralRequests, identities: { matches(identity: import("./data/identity-registry.ts").SupervisorIdentity): Promise<boolean> } = { async matches() { return true; } }) {
  const saved: any[] = [];
  const commands: CentralMcpCommands = {
    async submit(input) { const command = { ...input, id: "one", status: "queued" as const, createdAt: "now", updatedAt: "now" }; saved.push(command); return { command, created: true }; },
    async get(id) { const command = saved.find((item) => item.id === id); if (!command) throw new CommandError("not_found", "missing"); return command; },
    async list(status, scope, pagination) {
      if (pagination?.cursor !== undefined) throw new CommandError("invalid", "invalid cursor");
      return { commands: saved.filter((item) => (!status || item.status === status) && (!scope?.hostId || item.hostId === scope.hostId) && (!scope?.target || item.target === scope.target)).slice(0, pagination?.limit ?? 100), nextCursor: null };
    },
    async transition() { throw new Error("not used"); },
  };
  const fencedIdentities = { ...identities, async lockActive(_tx: unknown, identity: import("./data/identity-registry.ts").SupervisorIdentity) { return identities.matches(identity); } };
  return { app: createCentralApp({ auth, commands, requests, identities: fencedIdentities, allowedOrigins: ["http://localhost"] }), saved };
}
const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const command = { hostId: "h1", target: "s1", text: "run", idempotencyKey: "key", actor: "spoofed" };

describe("central HTTP boundary", () => {
  test("requires bearer authentication and operator role on all API routes", async () => {
    const { app } = fixture();
    expect((await app.request("/api/commands")).status).toBe(401);
    expect((await app.request("/api/commands", { headers: headers("host") })).status).toBe(403);
    expect((await app.request("/api/commands", { headers: headers("supervisor") })).status).toBe(403);
    expect((await app.request("/api/hosts", { headers: headers("supervisor") })).status).toBe(403);
    expect((await app.request("/api/hosts", { headers: headers("host") })).status).toBe(403);
    expect((await app.request("/mcp", { headers: headers("host") })).status).toBe(403);
    expect((await app.request("/unknown")).status).toBe(401);
  });
  test("rejects foreign origin and records authenticated actor", async () => {
    const { app, saved } = fixture();
    const send = (origin: string) => app.request("http://localhost/api/commands", { method: "POST", headers: { ...headers("operator"), origin }, body: JSON.stringify(command) });
    expect((await send("https://evil.example")).status).toBe(403);
    expect(saved).toHaveLength(0);
    expect((await send("http://localhost")).status).toBe(201);
    expect(saved[0].actor).toBe("alice");
    expect((await (await app.request("/api/commands", { headers: headers("operator") })).json()).commands).toHaveLength(1);
    expect((await app.request("/api/commands/one", { headers: headers("operator") })).status).toBe(200);
    expect((await app.request("/api/commands/missing", { headers: headers("operator") })).status).toBe(404);
  });
  test("limits streamed bodies, validates input and rejects bad status", async () => {
    const { app, saved } = fixture();
    const send = (body: string) => app.request("/api/commands", { method: "POST", headers: headers("operator"), body });
    expect((await send("{" )).status).toBe(400);
    expect((await send(JSON.stringify({ ...command, text: 42 }))).status).toBe(400);
    expect((await send("x".repeat(32769))).status).toBe(413);
    for (const query of ["status=bogus", "limit=0", "limit=1001", "limit=1.5", "limit=", "limit=-1", "cursor=bad", "hostId=", "target="]) {
      expect((await app.request(`/api/commands?${query}`, { headers: headers("operator") })).status).toBe(400);
    }
    expect(saved).toHaveLength(0);
  });
  test("command filter reads claimed records", async () => {
    const { app, saved } = fixture();
    saved.push({ ...command, id: "claimed-id", status: "claimed" }, { ...command, id: "queued-id", status: "queued" });
    const response = await app.request("/api/commands?status=claimed", { headers: headers("operator") });
    expect(response.status).toBe(200);
    expect((await response.json()).commands.map((item: { id: string }) => item.id)).toEqual(["claimed-id"]);
  });
  test("MCP authenticates before dispatch and bounds requests", async () => {
    const { app } = fixture();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    const response = await app.request("/mcp", { method: "POST", headers: { ...headers("supervisor"), accept: "application/json, text/event-stream" }, body });
    expect(response.status).toBe(200);
    expect((await response.json()).result.serverInfo.name).toBe("fleet-control-central");
    expect((await app.request("/mcp", { method: "POST", headers: headers("operator"), body: "x".repeat(32769) })).status).toBe(413);
  });
  test("rechecks supervisor identity for each MCP request and fails closed", async () => {
    let active = true;
    let fail = false;
    const seen: unknown[] = [];
    const { app } = fixture(undefined, { async matches(identity) { seen.push(identity); if (fail) throw new Error("database unavailable"); return active; } });
    const call = (token: string) => app.request("/mcp", { method: "POST", headers: { ...headers(token), accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    expect((await call("supervisor")).status).toBe(200);
    active = false;
    expect((await call("supervisor")).status).toBe(401);
    fail = true;
    expect((await call("supervisor")).status).toBe(401);
    expect((await call("operator")).status).toBe(200);
    expect(seen).toEqual(Array(3).fill({ name: "supervisor", principalId: "supervisor-id", hostId: "h1", session: "s1" }));
  });
  test("HTTP MCP exposes approval tools with authenticated role and ownership scopes", async () => {
    const calls: unknown[] = [];
    const owner = `central-supervisor\n${JSON.stringify(["supervisor", "supervisor-id", "h1", "s1"])}`;
    const requests = {
      async registerRun(input: { runId: string; orchestrator: string }, guard: (tx: any) => Promise<void>) {
        await guard({});
        if (input.runId !== "own" || input.orchestrator !== owner) throw new Error("access denied");
        calls.push(input); return input;
      },
      async gateScoped(runId: string, phase: string, revision: number, actor: string, guard: (tx: any) => Promise<void>) {
        await guard({});
        if (runId !== "own" || actor !== owner) throw new Error("access denied");
        calls.push({ runId, phase, revision }); return { approved: false };
      },
      async resolve(input: unknown) { calls.push(input); return input; },
    } as unknown as CentralRequests;
    const { app } = fixture(requests);
    const rpc = async (token: string, method: string, params: object = {}) => {
      const response = await app.request("/mcp", { method: "POST", headers: { ...headers(token), accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      expect(response.status).toBe(200);
      return (await response.json()).result;
    };
    const operatorTools = (await rpc("operator", "tools/list")).tools.map((tool: { name: string }) => tool.name);
    const supervisorTools = (await rpc("supervisor", "tools/list")).tools.map((tool: { name: string }) => tool.name);
    expect(operatorTools).toContain("request_resolve");
    expect(operatorTools).not.toContain("request_gate");
    expect(supervisorTools).toContain("request_gate");
    expect(supervisorTools).toContain("run_register");
    expect(supervisorTools).not.toContain("request_resolve");
    const registered = await rpc("supervisor", "tools/call", { name: "run_register", arguments: { runId: "own", phase: "plan", orchestrator: "spoofed" } });
    expect(calls[0]).toEqual({ runId: "own", phase: "plan", orchestrator: owner });
    expect(JSON.parse(registered.content[0].text).run.orchestrator).toBe("supervisor");
    expect(JSON.stringify(registered)).not.toContain("supervisor-id");
    const denied = await rpc("supervisor", "tools/call", { name: "request_gate", arguments: { runId: "other", phase: "plan", revision: 1 } });
    expect(denied.isError).toBe(true);
    expect(calls).toHaveLength(1);
    const allowed = await rpc("supervisor", "tools/call", { name: "request_gate", arguments: { runId: "own", phase: "plan", revision: 1 } });
    expect(allowed.isError).not.toBe(true);
    expect(calls[1]).toEqual({ runId: "own", phase: "plan", revision: 1 });
    await rpc("operator", "tools/call", { name: "request_resolve", arguments: { requestId: "req", response: "approve", expectedRevision: 1, actor: "spoofed" } });
    expect(calls[2]).toEqual({ requestId: "req", response: "approve", expectedRevision: 1, actor: "alice" });
  });
  test("rejects non-loopback bind without TLS", () => {
    expect(() => assertSafeCentralBind("127.0.0.1", undefined)).not.toThrow();
    expect(() => assertSafeCentralBind("0.0.0.0", undefined)).toThrow();
    expect(() => assertSafeCentralBind("0.0.0.0", { cert: "cert", key: "key" })).not.toThrow();
  });
});
