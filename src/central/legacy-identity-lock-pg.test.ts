import { SQL } from "bun";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Principal } from "./auth.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { buildCentralMcpServer, type CentralMcpCommands } from "./mcp.ts";
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
    await registry.initialize();
    await requests.initialize();
    const id = crypto.randomUUID();
    const principal = { role: "supervisor" as const, principalId: `principal-${id}`, name: `supervisor-${id}`, hostId: `host-${id}`, session: "session" } satisfies Principal;
    const identity = { principalId: principal.principalId, name: principal.name, hostId: principal.hostId, session: principal.session };
    await registry.enroll(identity);
    // Same wiring as src/central/server.ts: the real registry's lockActive, bound, inside the store transaction.
    const identities = { lockActive: registry.lockActive.bind(registry) };
    const server = buildCentralMcpServer({ commands: {} as CentralMcpCommands, requests, identities }, principal);
    const client = new Client({ name: "legacy-identity-lock-pg", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    opened.unshift({ close: async () => { try { await client.close(); } finally { await server.close(); } } });
    return { db, other, observer, registry, principal, identity, client, cleanup };
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
