import { SQL } from "bun";
import { expect, test } from "bun:test";
import { provisionCooperative } from "./cooperative-provision.ts";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import { CooperativeReconciliation } from "./cooperative-reconciliation.ts";
import { CentralRequests } from "./requests.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;
const fresh = () => `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;

pgTest("fresh installation is isolated, atomic and usable by cooperative stores", async () => {
  const parsed = new URL(url!);
  if (parsed.protocol !== "postgres:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "57507" || parsed.pathname !== "/fleet_control_test") throw new Error("refusing non-disposable test database");
  const admin = new SQL(url!);
  const schema = fresh(), rollback = fresh(), sentinel = fresh();
  let created = false, sentinelCreated = false;
  let db: SQL | undefined;
  try {
    await admin`CREATE SCHEMA ${admin(sentinel)}`;
    sentinelCreated = true;
    await admin`CREATE TABLE ${admin(sentinel)}.legacy_sentinel (value TEXT NOT NULL)`;
    await admin`INSERT INTO ${admin(sentinel)}.legacy_sentinel VALUES ('unchanged')`;
    const results = await Promise.allSettled([provisionCooperative(admin, { testSchema: schema }), provisionCooperative(admin, { testSchema: schema })]);
    created = results.some((result) => result.status === "fulfilled");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(provisionCooperative(admin, { testSchema: rollback, beforeCommit: () => { throw new Error("injected failure"); } })).rejects.toThrow("injected failure");
    expect(await admin`SELECT 1 FROM pg_namespace WHERE nspname = ${rollback}`).toHaveLength(0);
    await expect(provisionCooperative(admin, { testSchema: "public" })).rejects.toThrow("invalid disposable test schema");
    expect(await admin`SELECT value FROM ${admin(sentinel)}.legacy_sentinel`).toEqual([{ value: "unchanged" }]);
    db = new SQL(url!, { connection: { search_path: schema } });
    expect(await db`SELECT version FROM central_cooperative_schema_marker`).toEqual([{ version: "fleet_cooperative_v1" }]);
    const identity = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const identities = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const commands = new CentralCommands(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    const reconciliation = new CooperativeReconciliation(db);
    await identities.enroll(identity);
    const credential = await incarnations.activate(identity);
    const { command } = await commands.submit({ idempotencyKey: "key", hostId: "host", target: "session", actor: "operator", text: "work" });
    expect((await claims.claim(identity, credential, "claim"))?.id).toBe(command.id);
    await expect(db`UPDATE central_commands SET text = 'changed' WHERE id = ${command.id}`).rejects.toThrow("claimed command cannot be mutated");
    await lifecycle.report(identity, credential, command.id, "report", "accepted", "accepted");
    const [{ seq }] = await db`SELECT seq::text AS seq FROM central_cooperative_lifecycle_events`;
    await reconciliation.reconcile({ role: "operator", name: "operator" }, command.id, "assert", "unknown", "test", seq, null);
    await expect(db`DELETE FROM central_cooperative_reconciliations`).rejects.toThrow("reconciliation is immutable");
    const delivery = (await commands.submit({ idempotencyKey: "delivery", hostId: "host", target: "session", actor: "operator", text: "deliver" })).command;
    const attempts = new CentralAttempts(db);
    const attempt = await attempts.begin(delivery.id, "host");
    expect((await attempts.finish(delivery.id, "host", attempt.id, "delivered", "receipt")).status).toBe("delivered");
    expect(await db`SELECT recovery_unknown FROM central_delivery_attempts`).toEqual([{ recovery_unknown: false }]);
    const requests = new CentralRequests(db);
    const run = await requests.registerRun({ runId: "run", orchestrator: "owner", phase: "plan" });
    expect(run.id).toBe("run");
    const request = await requests.create({ runId: "run", origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    expect((await requests.resolve({ requestId: request.id, actor: "operator", expectedRevision: 1, response: "approve" })).status).toBe("resolved");
    expect((await requests.acknowledge({ requestId: request.id, actor: "owner" })).status).toBe("acknowledged");
    expect((await requests.gate("run", "plan", 1)).approved).toBe(true);
    expect(await db`SELECT id FROM central_request_event_lock`).toEqual([{ id: 1 }]);
  } finally {
    await db?.close();
    if (created) await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
    if (sentinelCreated) await admin`DROP SCHEMA ${admin(sentinel)} CASCADE`;
    await admin.close();
  }
});

pgTest("provisioned catalog matches independently initialized stores", async () => {
  const parsed = new URL(url!);
  if (parsed.protocol !== "postgres:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "57507" || parsed.pathname !== "/fleet_control_test") throw new Error("refusing non-disposable test database");
  const admin = new SQL(url!);
  const provisioned = fresh(), initialized = fresh();
  let provisionedCreated = false, initializedCreated = false;
  let db: SQL | undefined;
  try {
    await provisionCooperative(admin, { testSchema: provisioned });
    provisionedCreated = true;
    await admin`CREATE SCHEMA ${admin(initialized)}`;
    initializedCreated = true;
    db = new SQL(url!, { connection: { search_path: initialized } });
    const incarnations = new SupervisorIncarnations(db);
    await new CentralCommands(db).initialize();
    await new CentralAttempts(db).initialize();
    await new SupervisorIdentityRegistry(db).initialize();
    await incarnations.initialize();
    await new CooperativeClaims(db, incarnations).initialize();
    await new CooperativeLifecycle(db, incarnations).initialize();
    await new CooperativeReconciliation(db).initialize();
    await new CentralRequests(db).initialize();

    const catalog = async (schema: string) => {
      const tables = await admin`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p') AND c.relname <> 'central_cooperative_schema_marker' ORDER BY c.relname`;
      const columns = await admin`SELECT c.relname AS table_name, a.attname AS name, a.attnum AS position, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_value FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p') AND c.relname <> 'central_cooperative_schema_marker' ORDER BY c.relname, a.attnum`;
      const indexes = await admin`SELECT t.relname AS table_name, i.indisunique AS is_unique, i.indisprimary AS is_primary, i.indisvalid AS is_valid, pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = ${schema} AND t.relname <> 'central_cooperative_schema_marker'`;
      const constraints = await admin`SELECT t.relname AS table_name, c.contype AS type, c.condeferrable AS deferrable, c.condeferred AS initially_deferred, c.convalidated AS validated, pg_get_constraintdef(c.oid, true) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = ${schema} AND t.relname <> 'central_cooperative_schema_marker'`;
      const normalize = (rows: Record<string, unknown>[]) => rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" ? value.replaceAll(schema + ".", "").replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, "CREATE $1INDEX ON ") : value]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { tables: normalize(tables), columns: normalize(columns), indexes: normalize(indexes), constraints: normalize(constraints) };
    };
    const actual = await catalog(provisioned), expected = await catalog(initialized);
    expect(actual.tables.length).toBeGreaterThan(0);
    expect(actual.tables).toEqual(expected.tables);
    expect(actual.columns).toEqual(expected.columns);
    expect(actual.indexes).toEqual(expected.indexes);
    expect(actual.constraints).toEqual(expected.constraints);
  } finally {
    await db?.close();
    if (provisionedCreated) await admin`DROP SCHEMA ${admin(provisioned)} CASCADE`;
    if (initializedCreated) await admin`DROP SCHEMA ${admin(initialized)} CASCADE`;
    await admin.close();
  }
});
