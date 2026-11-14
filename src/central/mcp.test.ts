import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Requests } from "../data/requests.ts";
import { RequestError } from "../domain/requests.ts";
import type { SQL, TransactionSQL } from "bun";
import type { CentralRequests } from "./data/requests.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CommandError, type CommandStatus } from "../domain/commands.ts";
import { CentralAuth } from "./auth.ts";
import type { Principal } from "./domain/identity.ts";
import { createHash } from "node:crypto";
import type { SupervisorReadGuard } from "./data/commands.ts";
import type { CentralCommand, CentralCommandInput, CommandListPagination, CommandListScope, CommandPage, SupervisorCommandScope } from "./domain/commands.ts";
import type { RequestMutationGuard } from "./data/requests.ts";
import { buildCentralMcpServer } from "./mcp.ts";
import type { CentralCommandStore } from "./application/commands.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";
import type { CooperativeClaims } from "./data/cooperative-claims.ts";
import type { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";

class FakeCommands implements CentralCommandStore {
  rows: CentralCommand[] = [];
  transitions: { id: string; status: CommandStatus; actor: string; detail: string }[] = [];
  listScopes: (CommandListScope | undefined)[] = [];
  listCalls: { status?: CommandStatus; scope?: CommandListScope; pagination?: CommandListPagination }[] = [];
  async submit(input: CentralCommandInput) {
    const existing = this.rows.find((row) => row.idempotencyKey === input.idempotencyKey);
    if (existing) return { command: existing, created: false };
    const command: CentralCommand = { ...input, id: `cmd-${this.rows.length + 1}`, status: "queued", createdAt: "now", updatedAt: "now" };
    this.rows.push(command);
    return { command, created: true };
  }
  async submitBounded(input: CentralCommandInput) { return this.submit(input); }
  async getBounded(id: string) { return this.get(id); }
  async listBounded(status?: CommandStatus, scope?: CommandListScope, pagination?: CommandListPagination) { return this.list(status, scope, pagination); }
  async get(id: string) {
    const command = this.rows.find((row) => row.id === id);
    if (!command) throw new CommandError("not_found", "missing");
    return command;
  }
  async list(status?: CommandStatus, scope?: CommandListScope, pagination: CommandListPagination = {}): Promise<CommandPage> {
    this.listScopes.push(scope);
    this.listCalls.push({ status, scope, pagination });
    const rows = this.rows.filter((row) => (!status || row.status === status) && (!scope?.hostId || row.hostId === scope.hostId) && (!scope?.target || row.target === scope.target));
    const start = pagination.cursor ? Number(pagination.cursor) : 0;
    const limit = pagination.limit ?? 100;
    return { commands: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? String(start + limit) : null };
  }
  async getScoped(id: string, scope: SupervisorCommandScope, guard: SupervisorReadGuard) {
    if (typeof guard !== "function" || await guard({} as TransactionSQL, scope) !== true) throw new Error("access denied");
    const command = this.rows.find((row) => row.id === id && row.hostId === scope.hostId && row.target === scope.session);
    if (!command) throw new Error("access denied");
    return command;
  }
  async listScoped(status: CommandStatus | undefined, scope: SupervisorCommandScope, guard: SupervisorReadGuard, pagination?: CommandListPagination) {
    if (typeof guard !== "function" || await guard({} as TransactionSQL, scope) !== true) throw new Error("access denied");
    return this.list(status, { hostId: scope.hostId, target: scope.session }, pagination);
  }
  async transitionScoped(id: string, status: "accepted" | "rejected" | "running" | "completed" | "failed", actor: string, detail: string, scope: SupervisorCommandScope, guard: SupervisorReadGuard) {
    if (typeof guard !== "function" || await guard({} as TransactionSQL, scope) !== true) throw new Error("access denied");
    const command = this.rows.find((row) => row.id === id && row.hostId === scope.hostId && row.target === scope.session);
    if (!command) throw new Error("access denied");
    return this.transition(id, status, actor, detail);
  }
  async transition(id: string, status: CommandStatus, actor: string, detail: string) {
    const command = await this.get(id);
    const allowed: Partial<Record<CommandStatus, CommandStatus[]>> = { queued: ["accepted", "rejected"], accepted: ["running", "completed", "failed"], running: ["completed", "failed"] };
    if (!allowed[command.status]?.includes(status)) throw new CommandError("conflict", "invalid transition");
    this.transitions.push({ id, status, actor, detail });
    command.status = status;
    return command;
  }
}

function fakeRequests(local: Requests): CentralRequests {
  return new Proxy(local, {
    get(target, property) {
      if (property === "list") return async (filter: Parameters<Requests["list"]>[0]) => ({ requests: target.list(filter), nextCursor: null });
      if (property === "gate") return async () => { throw new Error("unscoped gate not allowed for supervisors"); };
      if (property === "gateScoped") return async (runId: string, phase: string, revision: number, owner: string, guard: RequestMutationGuard) => {
        if (typeof guard !== "function") throw new Error("access denied");
        await guard({} as TransactionSQL);
        if (target.run(runId).orchestrator !== owner) throw new RequestError("forbidden", "access denied");
        return target.gate(runId, phase, revision);
      };
      if (["registerRun", "updatePhase", "create", "acknowledge", "withdraw"].includes(String(property))) {
        return async (input: unknown, guard?: RequestMutationGuard) => {
          if (typeof guard !== "function") throw new Error("access denied");
          await guard({} as TransactionSQL);
          return Reflect.apply(Reflect.get(target, property, target), target, [input]);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as CentralRequests;
}

async function connect(commands: FakeCommands, principal: Principal, requests?: CentralRequests) {
  const identity = principal.role === "supervisor" ? { name: principal.name, principalId: principal.principalId, hostId: principal.hostId, session: principal.session } : undefined;
  const server = buildCentralMcpServer({ commands, requests, identities: { async lockActive(_tx, candidate) { return !!identity && Object.keys(candidate).every((key) => candidate[key as keyof typeof candidate] === identity[key as keyof typeof identity]); } } }, principal);
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}
const result = (value: unknown) => JSON.parse((value as { content: { text: string }[] }).content[0]!.text);
const operator: Principal = { name: "alice", role: "operator" };
const supervisor: Principal = { name: "supervisor-identity", role: "supervisor", principalId: "supervisor-id", hostId: "host-a", session: "session-a" };

test("cooperative command list advertises and enforces its page size without changing legacy", async () => {
  const store = new FakeCommands();
  for (let i = 0; i < 6; i++) await store.submit({ hostId: "host", target: "session", text: "test", actor: "alice", idempotencyKey: String(i) });
  const auth = new CentralAuth([{ tokenHash: createHash("sha256").update("token").digest("hex"), principal: operator }]);
  const app = createCooperativeCentralApp({ auth, commands: store, claims: {} as CooperativeClaims, lifecycle: {} as CooperativeLifecycle, inspection: { async inspectBounded() { return null; } }, identities: { async matches() { return true; } } });
  const rpc = async (method: string, params: object = {}) => (await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  const tools = await rpc("tools/list");
  const limit = tools.result.tools.find((tool: { name: string }) => tool.name === "command_list").inputSchema.properties.limit;
  expect(limit.maximum).toBe(4);
  expect(limit.default).toBe(4);
  const call = (args: object) => rpc("tools/call", { name: "command_list", arguments: args });
  const first = result((await call({})).result);
  expect(first.commands).toHaveLength(4);
  expect(store.listCalls.at(-1)?.pagination).toEqual({ limit: 4 });
  expect(result((await call({ cursor: first.nextCursor, limit: 4 })).result).commands).toHaveLength(2);
  const callsBeforeInvalid = store.listCalls.length;
  expect((await call({ limit: 5 })).result.isError).toBe(true);
  expect(store.listCalls).toHaveLength(callsBeforeInvalid);
  const legacy = await connect(store, operator);
  try {
    const legacyLimit = (await legacy.client.listTools()).tools.find((tool) => tool.name === "command_list")!.inputSchema.properties!.limit as { maximum: number; default?: number };
    expect(legacyLimit.maximum).toBe(1000);
    expect(legacyLimit.default).toBeUndefined();
    expect((await legacy.client.callTool({ name: "command_list", arguments: { limit: 1000 } })).isError).not.toBe(true);
    await legacy.client.callTool({ name: "command_list", arguments: {} });
    expect(store.listCalls.at(-1)?.pagination).toEqual({});
  } finally { await legacy.client.close(); await legacy.server.close(); }
});

test("cooperative operator read budget counts double-encoded UTF-8 and leaves mutations and legacy unchanged", async () => {
  const store = new FakeCommands();
  const row = (await store.submit({ hostId: "host", target: "session", text: "small", actor: "alice", idempotencyKey: "initial" })).command;
  const auth = new CentralAuth([{ tokenHash: createHash("sha256").update("token").digest("hex"), principal: operator }]);
  const app = createCooperativeCentralApp({ auth, commands: store, claims: {} as CooperativeClaims, lifecycle: {} as CooperativeLifecycle, inspection: { async inspectBounded() { return null; } }, identities: { async matches() { return true; } } });
  const id = "\u0000".repeat(256);
  const call = async (name: string, args: object) => {
    const response = await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
    const text = await response.text();
    return { text, body: JSON.parse(text) };
  };
  const budget = 2 * 1024 * 1024;
  for (const name of ["command_get", "command_list"]) {
    const args = name === "command_get" ? { id: row.id } : {};
    row.text = ('\u0000"\\é').repeat(75000);
    const fits = await call(name, args);
    expect(fits.body.result.isError).not.toBe(true);
    expect(Buffer.byteLength(fits.text)).toBeLessThanOrEqual(budget);
    expect(result(fits.body.result)[name === "command_get" ? "command" : "commands"]).toBeDefined();
    row.text = ('\u0000"\\é').repeat(200000);
    const oversized = await call(name, args);
    expect(oversized.body.result.isError).toBe(true);
    expect(oversized.body.result.content[0].text).toBe("response exceeds read budget");
    expect(Buffer.byteLength(oversized.text)).toBeLessThanOrEqual(budget);
  }
  const legacy = await connect(store, operator);
  try {
    expect((await legacy.client.callTool({ name: "command_get", arguments: { id: row.id } })).isError).not.toBe(true);
  } finally { await legacy.client.close(); await legacy.server.close(); }
  const replay = await call("command_submit", { hostId: "host", target: "session", text: "new", idempotencyKey: "initial" });
  expect(replay.body.result.isError).not.toBe(true);
  expect(result(replay.body.result).created).toBe(false);
  const submitted = await call("command_submit", { hostId: "host", target: "session", text: "new", idempotencyKey: "new" });
  expect(submitted.body.result.isError).not.toBe(true);
  expect(result(submitted.body.result).created).toBe(true);
});

test("operator submits and reads commands without impersonation or supervisor actions", async () => {
  const store = new FakeCommands();
  const { client, server } = await connect(store, operator);
  expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["command_get", "command_list", "command_submit"]);
  const args = { hostId: "host-a", target: "session-a", text: "run tests", idempotencyKey: "key-1", actor: "forged" };
  const submitted = result(await client.callTool({ name: "command_submit", arguments: args }));
  expect(submitted.command.actor).toBe("alice");
  expect(submitted.command.status).toBe("queued");
  expect(result(await client.callTool({ name: "command_submit", arguments: args })).created).toBe(false);
  expect(result(await client.callTool({ name: "command_get", arguments: { id: submitted.command.id } })).command.id).toBe(submitted.command.id);
  expect(result(await client.callTool({ name: "command_list", arguments: {} })).commands).toHaveLength(1);
  expect((await client.callTool({ name: "command_respond", arguments: { id: submitted.command.id, decision: "accepted" } })).isError).toBe(true);
  await client.close(); await server.close();
});

test("supervisor only reads and acts on exact host and session", async () => {
  const store = new FakeCommands();
  const own = (await store.submit({ hostId: "host-a", target: "session-a", text: "own", actor: "alice", idempotencyKey: "1" })).command;
  const otherHost = (await store.submit({ hostId: "host-b", target: "session-a", text: "other", actor: "alice", idempotencyKey: "2" })).command;
  const otherSession = (await store.submit({ hostId: "host-a", target: "session-b", text: "other", actor: "alice", idempotencyKey: "3" })).command;
  const { client, server } = await connect(store, supervisor);
  expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["command_get", "command_list", "command_report", "command_respond"]);
  expect(result(await client.callTool({ name: "command_list", arguments: {} })).commands.map((c: CentralCommand) => c.id)).toEqual([own.id]);
  expect(store.listScopes).toEqual([{ hostId: "host-a", target: "session-a" }]);
  for (const [name, args] of [["command_get", {}], ["command_respond", { decision: "accepted" }], ["command_report", { status: "completed", evidence: "x" }]] as [string, Record<string, unknown>][]) {
    const missing = await client.callTool({ name, arguments: { ...args, id: "missing" } });
    for (const foreign of [otherHost, otherSession]) expect(await client.callTool({ name, arguments: { ...args, id: foreign.id } })).toEqual(missing);
  }
  for (const foreign of [otherHost, otherSession]) {
    expect((await client.callTool({ name: "command_get", arguments: { id: foreign.id } })).isError).toBe(true);
    expect((await client.callTool({ name: "command_respond", arguments: { id: foreign.id, decision: "accepted" } })).isError).toBe(true);
    expect((await client.callTool({ name: "command_report", arguments: { id: foreign.id, status: "completed", evidence: "x" } })).isError).toBe(true);
  }
  expect((await client.callTool({ name: "command_report", arguments: { id: own.id, status: "completed", evidence: "too early" } })).isError).toBe(true);
  expect((await client.callTool({ name: "command_respond", arguments: { id: own.id, decision: "delivered" } })).isError).toBe(true);
  expect((await client.callTool({ name: "command_submit", arguments: {} })).isError).toBe(true);
  await client.callTool({ name: "command_respond", arguments: { id: own.id, decision: "accepted", actor: "forged" } });
  const done = result(await client.callTool({ name: "command_report", arguments: { id: own.id, status: "completed", evidence: "tests passed", actor: "forged" } }));
  expect(done.command.status).toBe("completed");
  expect(store.transitions.map((t) => t.actor)).toEqual(["supervisor-identity", "supervisor-identity"]);
  expect(store.transitions.at(-1)?.detail).toBe("tests passed");
  await client.close(); await server.close();
});

test("command pagination forwards filters and retains supervisor scope on continuation", async () => {
  const store = new FakeCommands();
  for (const [hostId, target, key] of [["host-a", "session-a", "1"], ["host-b", "session-a", "2"], ["host-a", "session-a", "3"], ["host-a", "session-b", "4"]]) {
    await store.submit({ hostId: hostId!, target: target!, text: "test", actor: "alice", idempotencyKey: key! });
  }
  const owner = await connect(store, supervisor);
  const admin = await connect(store, operator);
  try {
    const call = (client: Client, args: Record<string, unknown>) => client.callTool({ name: "command_list", arguments: args });
    const first = result(await call(owner.client, { status: "queued", limit: 1, hostId: "host-b", target: "session-b" }));
    expect(first.commands.map((command: CentralCommand) => command.id)).toEqual(["cmd-1"]);
    expect(first.nextCursor).toBe("1");
    const second = result(await call(owner.client, { status: "queued", limit: 1, cursor: first.nextCursor }));
    expect(second.commands.map((command: CentralCommand) => command.id)).toEqual(["cmd-3"]);
    expect(second.nextCursor).toBeNull();
    expect(store.listCalls.slice(0, 2)).toEqual([
      { status: "queued", scope: { hostId: "host-a", target: "session-a" }, pagination: { limit: 1 } },
      { status: "queued", scope: { hostId: "host-a", target: "session-a" }, pagination: { limit: 1, cursor: "1" } },
    ]);
    store.rows[0]!.status = "claimed";
    const claimed = result(await call(owner.client, { status: "claimed" }));
    expect(claimed.commands.map((command: CentralCommand) => command.id)).toEqual(["cmd-1"]);
    expect(store.listCalls.at(-1)?.scope).toEqual({ hostId: "host-a", target: "session-a" });
    const operatorFirst = result(await call(admin.client, { limit: 2 }));
    const operatorSecond = result(await call(admin.client, { limit: 2, cursor: operatorFirst.nextCursor }));
    expect(operatorFirst.commands.map((command: CentralCommand) => command.id)).toEqual(["cmd-1", "cmd-2"]);
    expect(operatorSecond.commands.map((command: CentralCommand) => command.id)).toEqual(["cmd-3", "cmd-4"]);
    expect(operatorSecond.nextCursor).toBeNull();
    for (const args of [{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { cursor: "x".repeat(8193) }]) {
      expect((await call(admin.client, args)).isError).toBe(true);
    }
  } finally {
    await owner.client.close(); await owner.server.close();
    await admin.client.close(); await admin.server.close();
  }
});

test("request tools enforce role, principal ownership and revision scope", async () => {
  const db = new Database(":memory:");
  const requests = fakeRequests(new Requests(db));
  const commands = new FakeCommands();
  const alice = await connect(commands, operator, requests);
  const owner = await connect(commands, supervisor, requests);
  const other = await connect(commands, { name: "other-supervisor", role: "supervisor", principalId: "other-id", hostId: "host-b", session: "session-a" }, requests);
  const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  try {
    const ownerTools = (await owner.client.listTools()).tools.map((tool) => tool.name);
    const operatorTools = (await alice.client.listTools()).tools.map((tool) => tool.name);
    expect(ownerTools).not.toContain("request_list");
    expect(ownerTools).not.toContain("request_resolve");
    expect(operatorTools).not.toContain("request_create");
    expect(operatorTools).not.toContain("request_gate");
    expect(ownerTools).not.toContain("request_events");
    const run = result(await call(owner.client, "run_register", { runId: "run-a", phase: "plan", orchestrator: "other-supervisor" })).run;
    expect(run.orchestrator).toBe(supervisor.name);
    const req = result(await call(owner.client, "request_create", { runId: "run-a", expectedRevision: 1, kind: "approval", question: "Proceed?", origin: "forged" })).request;
    expect(req.origin).toBe(supervisor.name);
    expect((await call(other.client, "run_register", { runId: "run-a", phase: "plan", orchestrator: supervisor.name })).isError).toBe(true);
    for (const [name, args] of [
      ["phase_update", { runId: "run-a", expectedRevision: 1, phaseStatus: "planned", newRevision: true, actor: supervisor.name }],
      ["request_create", { runId: "run-a", expectedRevision: 1, kind: "approval", question: "steal", origin: supervisor.name }],
      ["request_gate", { runId: "run-a", phase: "plan", revision: 1 }],
      ["request_acknowledge", { requestId: req.id, actor: supervisor.name }],
      ["request_withdraw", { requestId: req.id, actor: supervisor.name, reason: "steal" }],
      ["request_get", { requestId: req.id }],
      ["request_list", {}],
      ["request_resolve", { requestId: req.id, response: "approve", expectedRevision: 1 }],
    ] as [string, Record<string, unknown>][]) expect((await call(other.client, name, args)).isError).toBe(true);
    for (const [name, args, key, foreignId] of [
      ["phase_update", { expectedRevision: 1, phaseStatus: "planned", newRevision: false }, "runId", "run-a"],
      ["request_create", { expectedRevision: 1, kind: "approval", question: "x" }, "runId", "run-a"],
      ["request_gate", { phase: "plan", revision: 1 }, "runId", "run-a"],
      ["request_acknowledge", {}, "requestId", req.id],
      ["request_withdraw", { reason: "x" }, "requestId", req.id],
    ] as [string, Record<string, unknown>, string, string][]) {
      expect(await call(other.client, name, { ...args, [key]: foreignId })).toEqual(await call(other.client, name, { ...args, [key]: "missing" }));
    }
    expect(result(await call(alice.client, "request_get", { requestId: req.id })).request.id).toBe(req.id);
    expect(result(await call(alice.client, "request_list", {})).requests).toHaveLength(1);
    const answer = result(await call(alice.client, "request_resolve", { requestId: req.id, response: "approve", expectedRevision: 1, actor: "forged" })).request;
    expect(answer.resolvedBy).toBe("alice");
    expect(result(await call(owner.client, "request_gate", { runId: "run-a", phase: "plan", revision: 1 })).approved).toBe(true);
    expect(result(await call(owner.client, "request_acknowledge", { requestId: req.id, actor: "forged" })).request.status).toBe("acknowledged");
    const stale = result(await call(owner.client, "request_create", { runId: "run-a", expectedRevision: 1, kind: "approval", question: "Again?" })).request;
    await call(owner.client, "phase_update", { runId: "run-a", expectedRevision: 1, phaseStatus: "planned", newRevision: true, actor: "forged" });
    expect((await call(alice.client, "request_resolve", { requestId: stale.id, response: "approve", expectedRevision: 1 })).isError).toBe(true);
    expect(result(await call(owner.client, "request_gate", { runId: "run-a", phase: "plan", revision: 2 })).approved).toBe(false);
    const withdraw = result(await call(owner.client, "request_create", { runId: "run-a", expectedRevision: 2, kind: "blocker", question: "Help?" })).request;
    expect(result(await call(owner.client, "request_withdraw", { requestId: withdraw.id, reason: "no longer needed", actor: "forged" })).request.status).toBe("withdrawn");
    expect(() => buildCentralMcpServer({ commands, requests }, { name: "host", role: "host", hostId: "host-a" })).toThrow();
  } finally {
    await alice.client.close(); await alice.server.close();
    await owner.client.close(); await owner.server.close();
    await other.client.close(); await other.server.close();
    db.close();
  }
});

test("run ownership remains bound to supervisor scope across fresh auth configurations", async () => {
  const db = new Database(":memory:");
  const localRequests = new Requests(db);
  const requests = fakeRequests(localRequests);
  const commands = new FakeCommands();
  const authenticate = (principal: Principal, token = "token") => new CentralAuth([{ tokenHash: createHash("sha256").update(token).digest("hex"), principal }]).authenticate(new Request("http://localhost", { headers: { authorization: `Bearer ${token}` } }))!;
  const owner = await connect(commands, authenticate(supervisor), requests);
  const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const connections = [owner];
  try {
    expect((await call(owner.client, "run_register", { runId: "bound", phase: "plan" })).isError).not.toBe(true);
    const req = result(await call(owner.client, "request_create", { runId: "bound", expectedRevision: 1, kind: "approval", question: "Proceed?" })).request;
    for (const principal of [{ ...supervisor, principalId: "different-id" }, { ...supervisor, hostId: "host-b" }, { ...supervisor, session: "session-b" }]) {
      const foreign = await connect(commands, authenticate(principal), requests);
      connections.push(foreign);
      for (const [name, args] of [
        ["run_register", { runId: "bound", phase: "plan" }],
        ["phase_update", { runId: "bound", expectedRevision: 1, phaseStatus: "stolen", newRevision: true }],
        ["request_create", { runId: "bound", expectedRevision: 1, kind: "blocker", question: "steal" }],
        ["request_gate", { runId: "bound", phase: "plan", revision: 1 }],
        ["request_withdraw", { requestId: req.id, reason: "steal" }],
        ["request_acknowledge", { requestId: req.id }],
      ] as [string, Record<string, unknown>][]) expect((await call(foreign.client, name, args)).isError).toBe(true);
    }
    for (const [runId, orchestrator] of [
      ["legacy-name", supervisor.name],
      ["legacy-scoped", "central-supervisor\n" + JSON.stringify([supervisor.name, supervisor.hostId, supervisor.session])],
    ] as [string, string][]) {
      localRequests.registerRun({ runId, phase: "plan", orchestrator });
      expect((await call(owner.client, "run_register", { runId, phase: "plan" })).isError).toBe(true);
      expect((await call(owner.client, "phase_update", { runId, expectedRevision: 1, phaseStatus: "stolen", newRevision: false })).isError).toBe(true);
    }
    const resumed = await connect(commands, authenticate(supervisor, "rotated-token"), requests);
    connections.push(resumed);
    expect((await call(resumed.client, "run_register", { runId: "bound", phase: "plan" })).isError).not.toBe(true);
    expect((await call(resumed.client, "request_gate", { runId: "bound", phase: "plan", revision: 1 })).isError).not.toBe(true);
  } finally {
    for (const connection of connections) { await connection.client.close(); await connection.server.close(); }
    db.close();
  }
});

test("host and incomplete supervisor cannot open an MCP server", () => {
  const commands = new FakeCommands();
  expect(() => buildCentralMcpServer({ commands }, { name: "host", role: "host", hostId: "host-a" })).toThrow();
  expect(() => buildCentralMcpServer({ commands }, { name: "bad", role: "supervisor", principalId: "bad-id", hostId: "host-a", session: "" })).toThrow();
});
