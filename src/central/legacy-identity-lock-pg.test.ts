import { SQL } from "bun";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Principal } from "./auth.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { CentralCommands } from "./commands.ts";
import { buildCentralMcpServer } from "./mcp.ts";
import { CentralRequests } from "./requests.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url.ts";

const url = centralTestDatabaseUrl(process.env);
const pgTest = url ? test : test.skip;
const connect = (options: { max?: number; connection?: Record<string, string> } = {}) => withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl, options));

// Backends in this database that wait on a lock held by blockerPid.
async function blockedBy(observer: SQL, blockerPid: number): Promise<number[]> {
  const rows = await observer<{ pid: number }[]>`SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND ${blockerPid} = ANY(pg_blocking_pids(pid))`;
  return rows.map((row) => row.pid);
}

// Bounded poll of pg_blocking_pids: about 5 seconds, then give up.
async function waitForBlocked(observer: SQL, blockerPid: number, waiterPid?: number): Promise<number | undefined> {
  for (let i = 0; i < 500; i++) {
    const pids = await blockedBy(observer, blockerPid);
    const found = waiterPid === undefined ? (pids.length === 1 ? pids[0] : undefined) : pids.find((pid) => pid === waiterPid);
    if (found !== undefined) return found;
    await Bun.sleep(10);
  }
  return undefined;
}

const withTimeout = <T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> =>
  Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error(`timed out waiting for ${label}`); })]);

async function fixture() {
  const admin = connect({ max: 1 });
  const schema = `legacy_identity_lock_${crypto.randomUUID().replaceAll("-", "")}`;
  let created = false;
  const opened: { close(): Promise<void> }[] = [];
  const cleanup = async () => {
    try {
      await Promise.allSettled(opened.map((connection) => connection.close()));
    } finally {
      try {
        if (created) await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
      } finally {
        await admin.close();
      }
    }
  };
  try {
    await admin`CREATE SCHEMA ${admin(schema)}`;
    created = true;
    const options = { connection: { search_path: `"${schema}"` } };
    const db = connect(options), other = connect(options), observer = connect({ ...options, max: 1 });
    opened.push(db, other, observer);
    const [location] = await db<{ schema: string }[]>`SELECT current_schema() AS schema`;
    expect(location!.schema).toBe(schema);
    const registry = new SupervisorIdentityRegistry(db);
    const requests = new CentralRequests(db);
    const commands = new CentralCommands(db);
    await registry.initialize();
    await requests.initialize();
    await commands.initialize();
    const id = crypto.randomUUID();
    const principal = { role: "supervisor" as const, principalId: `principal-${id}`, name: `supervisor-${id}`, hostId: `host-${id}`, session: "session" } satisfies Principal;
    const identity = { principalId: principal.principalId, name: principal.name, hostId: principal.hostId, session: principal.session };
    await registry.enroll(identity);
    // Same wiring as src/central/server.ts: the real registry's lockActive, bound, inside the store transaction.
    const identities = { lockActive: registry.lockActive.bind(registry) };
    const server = buildCentralMcpServer({ commands, requests, identities }, principal);
    const client = new Client({ name: "legacy-identity-lock-pg", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    opened.unshift({ close: async () => { try { await client.close(); } finally { await server.close(); } } });
    const owner = "central-supervisor\n" + JSON.stringify([principal.name, principal.principalId, principal.hostId, principal.session]);
    return { db, other, observer, registry, commands, requests, owner, principal, identity, client, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const pidOf = async (sql: SQL | import("bun").TransactionSQL) => (await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
const retired = async (sql: SQL, principalId: string) =>
  (await sql<{ retired: boolean }[]>`SELECT retired FROM central_supervisor_identities_v2 WHERE principal_id = ${principalId}`)[0]?.retired;

pgTest("legacy supervisor write holds the identity lock so a concurrent retire waits for its commit", async () => {
  const { db, other, observer, principal, identity, client, cleanup } = await fixture();
  let release = () => {};
  const pending: Promise<unknown>[] = [];
  const retirer = await other.reserve();
  try {
    const runId = `run-${crypto.randomUUID()}`;
    // Hold the request event lock. The store takes it after the guard, so the write pauses while it owns the identity row lock.
    let held!: (pid: number) => void;
    const holderReady = new Promise<number>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = other.begin(async (tx) => {
      await tx`SELECT id FROM central_request_event_lock WHERE id = 1 FOR UPDATE`;
      held(await pidOf(tx)); await gate;
    });
    pending.push(holder);
    const holderPid = await withTimeout(holderReady, "event lock holder");
    const write = client.callTool({ name: "run_register", arguments: { runId, phase: "plan" } });
    pending.push(write);
    const writerPid = await waitForBlocked(observer, holderPid);
    expect(writerPid).toBeDefined();

    const retirerPid = await pidOf(retirer);
    let retireSettled = false;
    const retire = new SupervisorIdentityRegistry(retirer).retire(identity).finally(() => { retireSettled = true; });
    pending.push(retire);
    // The retiring backend must be blocked by the writing backend, which holds the identity row lock.
    expect(await waitForBlocked(observer, writerPid!, retirerPid)).toBe(retirerPid);
    expect(retireSettled).toBe(false);
    expect(await retired(observer, principal.principalId)).toBe(false);

    release();
    await withTimeout(holder, "holder commit");
    const result = await withTimeout(write, "run_register");
    expect(result.isError).not.toBe(true);
    await withTimeout(retire, "retire");
    expect(await retired(observer, principal.principalId)).toBe(true);
    const runs = await observer<{ orchestrator: string }[]>`SELECT orchestrator FROM central_runs WHERE id = ${runId}`;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.orchestrator).toBe("central-supervisor\n" + JSON.stringify([principal.name, principal.principalId, principal.hostId, principal.session]));
    expect(await observer`SELECT 1 FROM central_request_events WHERE run_id = ${runId} AND kind = 'run_registered'`).toHaveLength(1);
    // After retirement the same supervisor can no longer write.
    const after = await withTimeout(client.callTool({ name: "run_register", arguments: { runId: `${runId}-after`, phase: "plan" } }), "post-retire write");
    expect(after.isError).toBe(true);
    expect(await observer`SELECT 1 FROM central_runs WHERE id = ${`${runId}-after`}`).toHaveLength(0);
  } finally {
    release();
    await Promise.allSettled(pending);
    retirer.release();
    await cleanup();
  }
}, 30_000);

pgTest("retire holding the identity lock makes a concurrent legacy supervisor write fail closed", async () => {
  const { db, other, observer, principal, identity, client, cleanup } = await fixture();
  let release = () => {};
  const pending: Promise<unknown>[] = [];
  try {
    const runId = `run-${crypto.randomUUID()}`;
    let held!: (pid: number) => void;
    const retireReady = new Promise<number>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const retirement = other.begin(async (tx) => {
      await new SupervisorIdentityRegistry(other, (operation) => operation(tx)).retire(identity);
      held(await pidOf(tx)); await gate;
    });
    pending.push(retirement);
    const retirerPid = await withTimeout(retireReady, "uncommitted retire");
    const eventsBefore = (await observer<{ count: number }[]>`SELECT count(*)::int AS count FROM central_request_events`)[0]!.count;

    const write = client.callTool({ name: "run_register", arguments: { runId, phase: "plan" } });
    pending.push(write);
    // The write must wait on the retiring transaction's identity row lock, not read the old row.
    expect(await waitForBlocked(observer, retirerPid)).toBeDefined();
    expect(await observer`SELECT 1 FROM central_runs WHERE id = ${runId}`).toHaveLength(0);

    release();
    await withTimeout(retirement, "retire commit");
    const result = await withTimeout(write, "run_register");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("request failed");
    expect(await retired(observer, principal.principalId)).toBe(true);
    expect(await observer`SELECT 1 FROM central_runs WHERE id = ${runId}`).toHaveLength(0);
    expect((await observer<{ count: number }[]>`SELECT count(*)::int AS count FROM central_request_events`)[0]!.count).toBe(eventsBefore);
    expect(await db`SELECT 1 FROM central_runs`).toHaveLength(0);
  } finally {
    release();
    await Promise.allSettled(pending);
    await cleanup();
  }
}, 30_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;
type ToolCase = {
  tool: string;
  // Committed rows created with the real stores before the retire starts. Returns the tool arguments and any strings
  // that must not appear in a fail-closed response.
  setup(f: Fixture): Promise<{ args: Record<string, unknown>; secrets: string[] }>;
};

const submitOwnCommand = async (f: Fixture, label: string) => (await f.commands.submit({
  hostId: f.principal.hostId, target: f.principal.session, text: `secret instruction ${label} ${crypto.randomUUID()}`, idempotencyKey: `key-${crypto.randomUUID()}`, actor: "operator",
})).command;
const registerOwnRun = async (f: Fixture) => {
  const runId = `run-${crypto.randomUUID()}`;
  await f.requests.registerRun({ runId, orchestrator: f.owner, phase: "plan" });
  return runId;
};
const createOwnRequest = async (f: Fixture, runId: string) =>
  (await f.requests.create({ runId, origin: f.owner, expectedRevision: 1, kind: "approval", question: `secret question ${crypto.randomUUID()}` })).id;

// Every supervisor tool in src/central/mcp.ts that reaches the identity guard.
const toolCases: ToolCase[] = [
  { tool: "run_register", setup: async () => ({ args: { runId: `run-${crypto.randomUUID()}`, phase: "plan" }, secrets: [] }) },
  { tool: "phase_update", setup: async (f) => ({ args: { runId: await registerOwnRun(f), expectedRevision: 1, phase: "build", phaseStatus: "moving on", newRevision: true }, secrets: [] }) },
  { tool: "request_create", setup: async (f) => ({ args: { runId: await registerOwnRun(f), expectedRevision: 1, kind: "approval", question: "may I?" }, secrets: [] }) },
  { tool: "request_acknowledge", setup: async (f) => {
    const requestId = await createOwnRequest(f, await registerOwnRun(f));
    await f.requests.resolve({ requestId, response: "approve", actor: "operator", expectedRevision: 1 });
    return { args: { requestId }, secrets: [requestId] };
  } },
  { tool: "request_withdraw", setup: async (f) => {
    const requestId = await createOwnRequest(f, await registerOwnRun(f));
    return { args: { requestId, reason: "no longer needed" }, secrets: [requestId] };
  } },
  { tool: "request_gate", setup: async (f) => {
    const runId = await registerOwnRun(f);
    const requestId = await createOwnRequest(f, runId);
    await f.requests.resolve({ requestId, response: "approve", actor: "operator", expectedRevision: 1 });
    return { args: { runId, phase: "plan", revision: 1 }, secrets: [requestId, "approved"] };
  } },
  { tool: "command_respond", setup: async (f) => {
    const command = await submitOwnCommand(f, "respond");
    return { args: { id: command.id, decision: "accepted", reason: "ok" }, secrets: [command.id, command.text] };
  } },
  { tool: "command_report", setup: async (f) => {
    const command = await submitOwnCommand(f, "report");
    await f.commands.transition(command.id, "accepted", "setup", "accepted for test");
    return { args: { id: command.id, status: "running", evidence: "started" }, secrets: [command.id, command.text] };
  } },
  { tool: "command_get", setup: async (f) => {
    const command = await submitOwnCommand(f, "get");
    return { args: { id: command.id }, secrets: [command.id, command.text] };
  } },
  { tool: "command_list", setup: async (f) => {
    const command = await submitOwnCommand(f, "list");
    return { args: {}, secrets: [command.id, command.text] };
  } },
];

// Full contents of every request and command table, so any write by the tool shows up as a difference.
async function snapshot(sql: SQL): Promise<string> {
  const tables = ["central_runs", "central_requests", "central_request_events", "central_commands", "central_command_events"];
  const parts: string[] = [];
  for (const table of tables) {
    const rows = await sql<{ row: string }[]>`SELECT to_jsonb(t)::text AS row FROM ${sql(table)} t ORDER BY 1`;
    parts.push(`${table}:${JSON.stringify(rows.map((r) => r.row))}`);
  }
  return parts.join("\n");
}

pgTest("every guarded supervisor tool is covered by the table", () => {
  const server = buildCentralMcpServer({ commands: {} as never, requests: {} as never, identities: { lockActive: async () => false } }, {
    role: "supervisor", principalId: "principal-x", name: "supervisor-x", hostId: "host-x", session: "session",
  });
  const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  expect(toolCases.map((c) => c.tool).sort()).toEqual(registered);
});

for (const toolCase of toolCases) {
  // Positive control: the same setup and arguments succeed while the identity is active, so a fail-closed result below is caused by the retire.
  pgTest(`${toolCase.tool} succeeds with the table fixture while the identity is active`, async () => {
    const f = await fixture();
    try {
      const { args, secrets } = await toolCase.setup(f);
      const result = await withTimeout(f.client.callTool({ name: toolCase.tool, arguments: args }), toolCase.tool);
      expect(result.isError).not.toBe(true);
      const text = JSON.stringify(result.content);
      if (toolCase.tool === "command_get" || toolCase.tool === "command_list" || toolCase.tool === "request_gate") for (const secret of secrets) expect(text).toContain(JSON.stringify(secret).slice(1, -1));
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  pgTest(`retire holding the identity lock makes ${toolCase.tool} fail closed`, async () => {
    const f = await fixture();
    const { other, observer, principal, identity, client, cleanup } = f;
    let release = () => {};
    const pending: Promise<unknown>[] = [];
    try {
      const { args, secrets } = await toolCase.setup(f);
      const before = await snapshot(observer);
      let held!: (pid: number) => void;
      const retireReady = new Promise<number>((resolve) => { held = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const retirement = other.begin(async (tx) => {
        await new SupervisorIdentityRegistry(other, (operation) => operation(tx)).retire(identity);
        held(await pidOf(tx)); await gate;
      });
      pending.push(retirement);
      const retirerPid = await withTimeout(retireReady, "uncommitted retire");

      const call = client.callTool({ name: toolCase.tool, arguments: args });
      pending.push(call);
      // The tool must wait on the retiring transaction's identity row lock, not read the old row.
      expect(await waitForBlocked(observer, retirerPid)).toBeDefined();
      expect(await snapshot(observer)).toBe(before);

      release();
      await withTimeout(retirement, "retire commit");
      const result = await withTimeout(call, toolCase.tool);
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toBe(JSON.stringify([{ type: "text", text: "request failed" }]));
      for (const secret of secrets) expect(text).not.toContain(secret);
      expect(await retired(observer, principal.principalId)).toBe(true);
      expect(await snapshot(observer)).toBe(before);
    } finally {
      release();
      await Promise.allSettled(pending);
      await cleanup();
    }
  }, 30_000);
}

pgTest("command_respond holds the identity lock so a concurrent retire waits for its commit", async () => {
  const f = await fixture();
  const { other, observer, principal, identity, client, cleanup } = f;
  let release = () => {};
  const pending: Promise<unknown>[] = [];
  const retirer = await other.reserve();
  try {
    const command = await submitOwnCommand(f, "respond-first");
    // Hold the command event lock. transitionScoped takes it after the guard, so the tool pauses while it owns the identity row lock.
    let held!: (pid: number) => void;
    const holderReady = new Promise<number>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = other.begin(async (tx) => {
      await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      held(await pidOf(tx)); await gate;
    });
    pending.push(holder);
    const holderPid = await withTimeout(holderReady, "event lock holder");
    const respond = client.callTool({ name: "command_respond", arguments: { id: command.id, decision: "accepted", reason: "go" } });
    pending.push(respond);
    const toolPid = await waitForBlocked(observer, holderPid);
    expect(toolPid).toBeDefined();

    const retirerPid = await pidOf(retirer);
    let retireSettled = false;
    const retire = new SupervisorIdentityRegistry(retirer).retire(identity).finally(() => { retireSettled = true; });
    pending.push(retire);
    expect(await waitForBlocked(observer, toolPid!, retirerPid)).toBe(retirerPid);
    expect(retireSettled).toBe(false);
    expect(await retired(observer, principal.principalId)).toBe(false);

    release();
    await withTimeout(holder, "holder commit");
    const result = await withTimeout(respond, "command_respond");
    expect(result.isError).not.toBe(true);
    await withTimeout(retire, "retire");
    expect(await retired(observer, principal.principalId)).toBe(true);
    const [stored] = await observer<{ status: string }[]>`SELECT status FROM central_commands WHERE id = ${command.id}`;
    expect(stored!.status).toBe("accepted");
    expect(await observer`SELECT 1 FROM central_command_events WHERE command_id = ${command.id} AND status = 'accepted' AND actor = ${principal.name}`).toHaveLength(1);
    // After retirement the same supervisor can no longer report on it.
    const after = await withTimeout(client.callTool({ name: "command_report", arguments: { id: command.id, status: "running", evidence: "late" } }), "post-retire report");
    expect(after.isError).toBe(true);
    expect((await observer<{ status: string }[]>`SELECT status FROM central_commands WHERE id = ${command.id}`)[0]!.status).toBe("accepted");
  } finally {
    release();
    await Promise.allSettled(pending);
    retirer.release();
    await cleanup();
  }
}, 30_000);
