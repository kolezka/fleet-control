import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { CentralRequests } from "./requests.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import { CooperativeReconciliation } from "./cooperative-reconciliation.ts";
import { CooperativeSettlement } from "./cooperative-settlement.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url.ts";

// Each test works in its own schema of the disposable database and drops it afterwards.
const url = centralTestDatabaseUrl(process.env);
const pgTest = url ? test : test.skip;
const missing = "central command event lock row missing";
const operator = { role: "operator" as const, name: "operator" };
const live = { role: "supervisor" as const, principalId: "live", name: "live", hostId: "host", session: "session" };
const gone = { role: "supervisor" as const, principalId: "gone", name: "gone", hostId: "host", session: "retired" };

type Context = { schema: string; admin: SQL; db: SQL; open: () => SQL };
type Writer = { name: string; run: () => Promise<unknown>; done: (result: unknown) => void | Promise<void> };
const writer = <T>(name: string, run: () => Promise<T>, done: (result: T) => void | Promise<void>): Writer => ({ name, run, done: done as Writer["done"] });

async function withSchema(work: (context: Context) => Promise<void>) {
  const connect = (options: Record<string, unknown> = {}) => withValidatedTestDatabaseUrl(process.env, url!, (current) => new SQL(current, options));
  const admin = connect();
  const schema = `lock_missing_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const clients: SQL[] = [];
  // One connection per client, so a client has one backend pid to watch.
  const open = () => { const client = connect({ max: 1, connection: { search_path: schema } }); clients.push(client); return client; };
  await admin`CREATE SCHEMA ${admin(schema)}`;
  try { await work({ schema, admin, db: open(), open }); }
  finally {
    for (const client of clients) await client.close().catch(() => {});
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
}

const within = async <T>(work: Promise<T>, what: string, ms = 5_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); })]); }
  finally { clearTimeout(timer); }
};

// Every row of every table in the schema, as text.
async function snapshot({ admin, schema }: Context) {
  const tables = await admin<{ name: string }[]>`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${schema} ORDER BY table_name`;
  const state: Record<string, string> = {};
  for (const { name } of tables) {
    const [row] = await admin<{ rows: string }[]>`SELECT coalesce(json_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::json)::text AS rows FROM ${admin(schema)}.${admin(name)} AS t`;
    state[name] = row!.rows;
  }
  return state;
}

// Builds a state in which each writer below is valid on its own, and returns the writers.
async function prepare({ admin, schema, db }: Context) {
  const commands = new CentralCommands(db), attempts = new CentralAttempts(db), registry = new SupervisorIdentityRegistry(db), incarnations = new SupervisorIncarnations(db);
  const claims = new CooperativeClaims(db, incarnations), lifecycle = new CooperativeLifecycle(db, incarnations), reconciliation = new CooperativeReconciliation(db), settlement = new CooperativeSettlement(db);
  await commands.initialize(); await attempts.initialize(); await registry.initialize(); await incarnations.initialize();
  await claims.initialize(); await lifecycle.initialize(); await reconciliation.initialize(); await settlement.initialize();
  const submit = async (key: string, target: string) => (await commands.submit({ idempotencyKey: key, hostId: "host", target, actor: "operator", text: key })).command;
  await registry.enroll(live); await registry.enroll(gone);
  const credential = await incarnations.activate(live), old = await incarnations.activate(gone);
  // "side" has no supervisor, so claims never pick these up.
  const plain = await submit("plain", "side"), scoped = await submit("scoped", "side"), begun = await submit("begun", "side"), finished = await submit("finished", "side");
  const started = await attempts.begin(finished.id, "host");
  const reported = await submit("reported", "session");
  expect((await claims.claim(live, credential, "claim-reported"))?.id).toBe(reported.id);
  const queued = await submit("queued", "session");
  const orphan = await submit("orphan", "retired");
  expect((await claims.claim(gone, old, "claim-orphan"))?.id).toBe(orphan.id);
  // Replacing the incarnation leaves the orphan's claim open for settlement.
  await incarnations.activate(gone);
  const latestReport = async () => (await admin<{ seq: string }[]>`SELECT seq::text AS seq FROM ${admin(schema)}.central_cooperative_lifecycle_events WHERE command_id = ${reported.id} ORDER BY seq DESC LIMIT 1`)[0]?.seq ?? null;
  let begunAttempt = "";
  return [
    writer("submit", () => commands.submit({ idempotencyKey: "fresh", hostId: "host", target: "side", actor: "operator", text: "fresh" }), (result) => { expect(result.created).toBe(true); }),
    writer("transition", () => commands.transition(plain.id, "accepted", "operator", "ok"), (command) => { expect(command.status).toBe("accepted"); }),
    writer("scoped transition", () => commands.transitionScoped(scoped.id, "accepted", "supervisor", "ok", { hostId: "host", session: "side" }, async () => true), (command) => { expect(command.status).toBe("accepted"); }),
    writer("attempt begin", () => attempts.begin(begun.id, "host"), (attempt) => { expect(attempt.status).toBe("started"); begunAttempt = attempt.id; }),
    writer("attempt finish", () => attempts.finish(finished.id, "host", started.id, "delivered", "ok"), async () => { expect((await commands.get(finished.id)).status).toBe("delivered"); }),
    writer("command restart recovery", () => commands.reconcileAfterRestart(), (ids) => { expect(ids).toEqual([begun.id]); }),
    writer("attempt restart recovery", () => attempts.reconcileAfterRestart(), (ids) => { expect(ids).toEqual([begunAttempt]); }),
    writer("claim", () => claims.claim(live, credential, "claim-queued"), (command) => { expect(command).toMatchObject({ id: queued.id, status: "claimed" }); }),
    writer("lifecycle report", () => lifecycle.report(live, credential, reported.id, "accept", "accepted", "seen"), (event) => { expect(event.status).toBe("accepted"); }),
    writer("reconciliation", async () => reconciliation.reconcile(operator, reported.id, "assert", "unknown", "evidence", await latestReport(), null), (assertion) => { expect(assertion.sequence).toBe("1"); }),
    writer("settlement", () => settlement.settle(operator, orphan.id, "settle", "unknown", "evidence", null), (result) => { expect(result.created).toBe(true); }),
  ];
}

pgTest("PostgreSQL: without the event lock row every command event writer fails and writes nothing", async () => {
  await withSchema(async (context) => {
    const { admin, schema } = context;
    const writers = await prepare(context);
    await admin`DELETE FROM ${admin(schema)}.central_command_event_lock`;
    const before = await snapshot(context);
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(10);
    expect(before.central_commands).toContain("plain");
    for (const { name, run } of writers) {
      try { await run(); throw new Error(`${name} did not fail`); }
      catch (error) { expect(`${name}: ${(error as Error).message}`).toBe(`${name}: ${missing}`); }
      expect(await snapshot(context)).toEqual(before);
    }
    // The snapshot does notice a write: with the row back, the first writer changes it.
    await admin`INSERT INTO ${admin(schema)}.central_command_event_lock (id) VALUES (1)`;
    await writers[0]!.run();
    expect(await snapshot(context)).not.toEqual(before);
  });
}, 30_000);

pgTest("PostgreSQL: every command event writer waits while another transaction holds the event lock", async () => {
  await withSchema(async (context) => {
    const { admin, db, open } = context;
    const writers = await prepare(context);
    const holder = open();
    const pidOf = async (client: SQL) => (await client<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
    const pid = await pidOf(db), holderPid = await pidOf(holder);
    expect(pid).not.toBe(holderPid);
    for (const { name, run, done } of writers) {
      let held!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => { held = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
      const holding = holder.begin(async (tx) => { await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`; held(); await released; });
      holding.catch(() => {});
      let call: Promise<unknown> | undefined;
      try {
        await within(Promise.race([reached, holding]), `the lock holder before ${name}`);
        call = run();
        call.catch(() => {});
        let waiting = false;
        for (let i = 0; i < 200 && !waiting; i++) {
          const [row] = await admin<{ locked: boolean | null; query: string; blocked: boolean | null }[]>`SELECT wait_event_type = 'Lock' AS locked, query, ${holderPid}::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = ${pid}`;
          waiting = !!row?.locked && !!row.blocked && row.query.includes("central_command_event_lock");
          if (!waiting) await Bun.sleep(25);
        }
        if (!waiting) throw new Error(`${name} never waited on the event lock`);
      } finally {
        release();
        await holding.catch(() => {});
      }
      await done(await within(call!, `${name} after the lock was released`));
    }
  });
}, 60_000);

pgTest("PostgreSQL: initialization without the event lock row replaces no trigger", async () => {
  await withSchema(async ({ admin, schema, db }) => {
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    await new CentralCommands(db).initialize(); await new SupervisorIdentityRegistry(db).initialize(); await incarnations.initialize();
    const table = async (name: string) => (await admin<{ found: boolean }[]>`SELECT to_regclass(${`${schema}.${name}`}) IS NOT NULL AS found`)[0]!.found;
    const routines = async (name: string) => (await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_proc JOIN pg_namespace ON pg_namespace.oid = pronamespace WHERE nspname = ${schema} AND proname = ${name}`)[0]!.count;
    const triggers = async (name: string) => (await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_trigger JOIN pg_class ON pg_class.oid = tgrelid JOIN pg_namespace ON pg_namespace.oid = relnamespace WHERE nspname = ${schema} AND tgname = ${name} AND NOT tgisinternal`)[0]!.count;
    const removeLock = () => admin`DELETE FROM ${admin(schema)}.central_command_event_lock`;

    // Claims create their table and function inside the failing transaction, so both roll back.
    await removeLock();
    await expect(claims.initialize()).rejects.toThrow(missing);
    expect(await table("central_cooperative_claims")).toBe(false);
    expect(await routines("central_block_cooperative_claim_mutation")).toBe(0);

    await admin`INSERT INTO ${admin(schema)}.central_command_event_lock (id) VALUES (1)`;
    await claims.initialize();
    expect(await table("central_cooperative_claims")).toBe(true);
    expect(await triggers("central_block_cooperative_claim_mutation")).toBe(1);

    // An installed claim trigger survives a later failed initialization.
    await removeLock();
    await expect(claims.initialize()).rejects.toThrow(missing);
    expect(await triggers("central_block_cooperative_claim_mutation")).toBe(1);

    // These two create their table and function before the transaction; only the trigger is withheld.
    await expect(new CooperativeReconciliation(db).initialize()).rejects.toThrow(missing);
    expect(await table("central_cooperative_reconciliations")).toBe(true);
    expect(await routines("central_block_reconciliation_mutation")).toBe(1);
    expect(await triggers("central_block_reconciliation_mutation")).toBe(0);
    await expect(new CooperativeSettlement(db).initialize()).rejects.toThrow(missing);
    expect(await table("central_cooperative_settlements")).toBe(true);
    expect(await routines("central_block_settlement_mutation")).toBe(1);
    expect(await triggers("central_block_settlement_mutation")).toBe(0);
  });
}, 30_000);

pgTest("PostgreSQL: without the request event lock row a request guard's write is rolled back", async () => {
  await withSchema(async (context) => {
    const { admin, schema, db } = context;
    const store = new CentralRequests(db);
    await store.initialize();
    await store.registerRun({ runId: "run", orchestrator: "owner", phase: "plan" });
    const request = await store.create({ runId: "run", origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    const guard = async (tx: SQL) => { await tx`INSERT INTO central_runs VALUES ('written-by-guard', 'guard', 'plan', 1, 'planned', 'now')`; };
    await admin`DELETE FROM ${admin(schema)}.central_request_event_lock`;
    const before = await snapshot(context);
    const calls: [string, () => Promise<unknown>][] = [
      ["registerRun", () => store.registerRun({ runId: "other", orchestrator: "owner", phase: "plan" }, guard)],
      ["updatePhase", () => store.updatePhase({ runId: "run", actor: "owner", expectedRevision: 1, phaseStatus: "running", newRevision: true }, guard)],
      ["create", () => store.create({ runId: "run", origin: "owner", expectedRevision: 1, kind: "approval", question: "Again?" }, guard)],
      ["resolve", () => store.resolve({ requestId: request.id, response: "approve", actor: "operator", expectedRevision: 1 })],
      ["acknowledge", () => store.acknowledge({ requestId: request.id, actor: "owner" }, guard)],
      ["withdraw", () => store.withdraw({ requestId: request.id, actor: "owner", reason: "not needed" }, guard)],
      ["gate", () => store.gate("run", "plan", 1)],
      ["gateScoped", () => store.gateScoped("run", "plan", 1, "owner", guard)],
    ];
    for (const [name, call] of calls) {
      try { await call(); throw new Error(`${name} did not fail`); }
      catch (error) { expect(`${name}: ${(error as Error).message}`).toBe(`${name}: central request event lock row missing`); }
      expect(await snapshot(context)).toEqual(before);
    }
    // The guard does write: with the row back, its run is committed with the registration.
    await admin`INSERT INTO ${admin(schema)}.central_request_event_lock (id) VALUES (1)`;
    await store.registerRun({ runId: "other", orchestrator: "owner", phase: "plan" }, guard);
    expect((await store.run("written-by-guard")).orchestrator).toBe("guard");
  });
}, 30_000);
