import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import { CooperativeReconciliation } from "./cooperative-reconciliation.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;

pgTest("independent assertions conflict on stale versions and preserve divergent evidence", async () => {
  const admin = new SQL(url!);
  const schema = `reconciliation_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  const other = new SQL(url!, { connection: { search_path: schema } });
  try {
    const supervisor = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const operator = { role: "operator" as const, name: "operator" };
    const commands = new CentralCommands(db);
    const registry = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    const store = new CooperativeReconciliation(db);
    const rival = new CooperativeReconciliation(other);
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize(); await claims.initialize(); await lifecycle.initialize(); await store.initialize();
    await registry.enroll(supervisor);
    const credential = await incarnations.activate(supervisor);
    const { command } = await commands.submit({ idempotencyKey: "one", hostId: "host", target: "session", actor: "operator", text: "work" });
    await claims.claim(supervisor, credential, "claim");
    const before = { command: await db`SELECT * FROM central_commands WHERE id = ${command.id}`, claim: await db`SELECT * FROM central_cooperative_claims WHERE command_id = ${command.id}`, events: await db`SELECT * FROM central_command_events WHERE command_id = ${command.id} ORDER BY seq`, attempts: await db`SELECT * FROM central_delivery_attempts WHERE command_id = ${command.id}` };
    const write = (request: string, disposition: "unknown" | "completed" | "failed" | "not-executed", lifecycleSeq: string | null, assertionSeq: string | null, evidence = "evidence") => store.reconcile(operator, command.id, request, disposition, evidence, lifecycleSeq, assertionSeq);
    await expect(store.reconcile(supervisor, command.id, "denied", "unknown", "", null, null)).rejects.toThrow(/denied/);
    await expect(store.reconcile(operator, "missing", "missing", "unknown", "", null, null)).rejects.toThrow(/denied/);
    await expect(write("invalid", "unknown", "01", null)).rejects.toThrow(/invalid/);
    await expect(write("invalid-version", "unknown", null, "01")).rejects.toThrow(/invalid/);
    const same = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? store : rival).reconcile(operator, command.id, "same", "unknown", "evidence", null, null)));
    expect(new Set(same.map((item) => JSON.stringify(item))).size).toBe(1);
    expect(same[0]).toMatchObject({ sequence: "1", supersedesSequence: null });
    await expect(write("same", "failed", null, null)).rejects.toThrow(/different intent/);
    const contested = await Promise.allSettled([
      write("assessment-a", "completed", null, "1", "saw result"),
      rival.reconcile(operator, command.id, "assessment-b", "failed", "saw error", null, "1")
    ]);
    expect(contested.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(contested.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = contested.find((result) => result.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("missing winner");
    expect(winner.value).toMatchObject({ sequence: "2", supersedesSequence: "1" });
    const losingRequest = winner.value.requestId === "assessment-a" ? "assessment-b" : "assessment-a";
    const loserDisposition = losingRequest === "assessment-a" ? "completed" : "failed";
    const loserEvidence = losingRequest === "assessment-a" ? "saw result" : "saw error";
    await expect(write(losingRequest, loserDisposition, null, "1", loserEvidence)).rejects.toThrow(/stale/);
    const successor = await write(losingRequest, loserDisposition, null, "2", loserEvidence);
    expect(successor).toMatchObject({ sequence: "3", supersedesSequence: "2" });
    expect(await write("same", "unknown", null, null)).toEqual(same[0]!);
    await lifecycle.report(supervisor, credential, command.id, "reject", "rejected", "rejected");
    const [rejected] = await db<{ seq: string }[]>`SELECT seq::text AS seq FROM central_cooperative_lifecycle_events WHERE command_id = ${command.id} ORDER BY seq DESC LIMIT 1`;
    await expect(write("stale-lifecycle", "completed", null, "3")).rejects.toThrow(/stale/);
    const disagreement = await write("human", "completed", rejected!.seq, "3", "independent observation");
    expect(disagreement).toMatchObject({ sequence: "4", supersedesSequence: "3", disposition: "completed" });
    const assertions = await db<{ request_id: string; disposition: string }[]>`SELECT request_id, disposition FROM central_cooperative_reconciliations WHERE command_id = ${command.id} ORDER BY sequence`;
    expect(assertions.map((row) => row.request_id)).toEqual(["same", winner.value.requestId, losingRequest, "human"]);
    await expect(db`UPDATE central_cooperative_reconciliations SET evidence = 'changed' WHERE request_id = 'human'`).rejects.toThrow(/immutable/);
    await expect(db`DELETE FROM central_cooperative_reconciliations WHERE request_id = 'human'`).rejects.toThrow(/immutable/);
    await db`CREATE FUNCTION fail_reconciliation_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`;
    await db`CREATE TRIGGER fail_reconciliation_insert AFTER INSERT ON central_cooperative_reconciliations FOR EACH ROW EXECUTE FUNCTION fail_reconciliation_insert()`;
    await expect(write("rollback", "unknown", rejected!.seq, "4")).rejects.toThrow(/injected failure/);
    expect(await db`SELECT request_id FROM central_cooperative_reconciliations WHERE request_id = 'rollback'`).toHaveLength(0);
    await db`DROP TRIGGER fail_reconciliation_insert ON central_cooperative_reconciliations`;
    expect(await write("rollback", "unknown", rejected!.seq, "4")).toMatchObject({ sequence: "5", supersedesSequence: "4" });
    await db`INSERT INTO central_cooperative_reconciliations (request_id, command_id, actor, disposition, evidence, expected_sequence, sequence, supersedes_sequence, at) VALUES ('large-fixture', ${command.id}, 'operator', 'unknown', '', ${rejected!.seq}, 9007199254740993, 5, 'fixture')`;
    expect(await write("large-next", "unknown", rejected!.seq, "9007199254740993")).toMatchObject({ sequence: "9007199254740994", supersedesSequence: "9007199254740993" });
    const beforeRead = await db`SELECT * FROM central_cooperative_reconciliations ORDER BY sequence`;
    await expect(store.list(supervisor, command.id)).rejects.toThrow(/denied/);
    await expect(store.list({ role: "operator", name: " " }, command.id)).rejects.toThrow(/denied/);
    expect(await store.list(operator, "missing")).toBeNull();
    for (const cursor of ["", "01", "-1", "1.0", "1".repeat(1001)]) await expect(store.list(operator, command.id, { cursor })).rejects.toThrow(/cursor/);
    for (const limit of [0, 1001, 1.5, NaN]) await expect(store.list(operator, command.id, { limit })).rejects.toThrow(/limit/);
    const firstPage = await store.list(operator, command.id, { limit: 2 });
    expect(firstPage?.assertions.map((item) => item.sequence)).toEqual(["1", "2"]);
    expect(firstPage?.nextCursor).toBe("2");
    const nextPage = await store.list(operator, command.id, { limit: 2, cursor: firstPage!.nextCursor! });
    expect(nextPage?.assertions.map((item) => item.sequence)).toEqual(["3", "4"]);
    const largePage = await store.list(operator, command.id, { limit: 1, cursor: "5" });
    expect(largePage?.assertions[0]).toMatchObject({ sequence: "9007199254740993", supersedesSequence: "5", expectedSequence: rejected!.seq });
    expect(largePage?.nextCursor).toBe("9007199254740993");
    expect((await store.list(operator, command.id, { cursor: largePage!.nextCursor! }))?.assertions.map((item) => item.sequence)).toEqual(["9007199254740994"]);
    expect(await store.list(operator, command.id, { cursor: "9".repeat(1000) })).toEqual({ assertions: [], nextCursor: null });
    expect(await db`SELECT * FROM central_cooperative_reconciliations ORDER BY sequence`).toEqual(beforeRead);
    expect(await db`SELECT * FROM central_commands WHERE id = ${command.id}`).toEqual(before.command);
    expect(await db`SELECT * FROM central_cooperative_claims WHERE command_id = ${command.id}`).toEqual(before.claim);
    expect(await db`SELECT * FROM central_command_events WHERE command_id = ${command.id} ORDER BY seq`).toEqual(before.events);
    expect(await db`SELECT * FROM central_delivery_attempts WHERE command_id = ${command.id}`).toEqual(before.attempts);
  } finally {
    await Promise.all([db.close(), other.close()]);
    try { await admin`DROP SCHEMA ${admin(schema)} CASCADE`; } finally { await admin.close(); }
  }
});

pgTest("assertion listing uses the supplied transaction runner and distinguishes empty claims", async () => {
  const admin = new SQL(url!);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const safe = `assertion_safe_${suffix}`;
  const shadow = `assertion_shadow_${suffix}`;
  await admin`CREATE SCHEMA ${admin(safe)}`;
  await admin`CREATE SCHEMA ${admin(shadow)}`;
  const db = new SQL(url!, { connection: { search_path: shadow } });
  try {
    await admin.unsafe(`CREATE TABLE "${safe}".central_cooperative_claims (command_id TEXT PRIMARY KEY)`);
    await admin.unsafe(`CREATE TABLE "${safe}".central_command_event_lock (id INTEGER PRIMARY KEY)`);
    await admin.unsafe(`INSERT INTO "${safe}".central_command_event_lock VALUES (1)`);
    const trusted = new SQL(url!, { connection: { search_path: safe } });
    try {
      await new CooperativeReconciliation(trusted).initialize();
      await trusted`INSERT INTO central_cooperative_claims VALUES ('empty'), ('present')`;
      await trusted`INSERT INTO central_cooperative_reconciliations (request_id, command_id, actor, disposition, evidence, sequence, at) VALUES ('real', 'present', 'operator', 'unknown', 'real evidence', 1, 'now')`;
      await db`CREATE TABLE central_cooperative_claims (command_id TEXT PRIMARY KEY)`;
      await db`CREATE TABLE central_cooperative_reconciliations (command_id TEXT, request_id TEXT, actor TEXT, disposition TEXT, evidence TEXT, expected_sequence TEXT, sequence NUMERIC, supersedes_sequence NUMERIC, at TEXT)`;
      await db`INSERT INTO central_cooperative_claims VALUES ('present')`;
      await db`INSERT INTO central_cooperative_reconciliations VALUES ('present', 'decoy', 'operator', 'unknown', 'shadow', NULL, 1, NULL, 'now')`;
      const store = new CooperativeReconciliation(db, undefined, (operation) => trusted.begin(operation));
      const operator = { role: "operator" as const, name: "operator" };
      expect(await store.list(operator, "empty")).toEqual({ assertions: [], nextCursor: null });
      expect((await store.list(operator, "present"))?.assertions[0]?.requestId).toBe("real");
      expect(await store.list(operator, "absent")).toBeNull();
    } finally { await trusted.close(); }
  } finally {
    await db.close();
    try { await admin`DROP SCHEMA ${admin(safe)} CASCADE`; await admin`DROP SCHEMA ${admin(shadow)} CASCADE`; } finally { await admin.close(); }
  }
});

pgTest("reconciliation trigger rejects mutations under a hostile caller search path", async () => {
  const admin = new SQL(url!);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const schema = `reconciliation_safe_${suffix}`;
  const hostileSchema = `reconciliation_hostile_${suffix}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  await admin`CREATE SCHEMA ${admin(hostileSchema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  const hostile = new SQL(url!, { connection: { search_path: `${hostileSchema},${schema}` } });
  try {
    await db`CREATE TABLE central_cooperative_claims (command_id TEXT PRIMARY KEY)`;
    await db`CREATE TABLE central_command_event_lock (id INTEGER PRIMARY KEY)`;
    await db`INSERT INTO central_command_event_lock VALUES (1)`;
    await db`INSERT INTO central_cooperative_claims VALUES ('command')`;
    await new CooperativeReconciliation(db).initialize();
    await db`INSERT INTO central_cooperative_reconciliations (request_id, command_id, actor, disposition, evidence, sequence, at) VALUES ('request', 'command', 'operator', 'unknown', 'original', 1, 'now')`;
    await hostile`CREATE FUNCTION central_block_reconciliation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END $$`;
    await hostile`CREATE TABLE central_cooperative_reconciliations (request_id TEXT, evidence TEXT)`;
    await hostile`INSERT INTO central_cooperative_reconciliations VALUES ('decoy', 'unchanged')`;
    await hostile`CREATE TRIGGER decoy_trigger BEFORE UPDATE OR DELETE ON central_cooperative_reconciliations FOR EACH ROW EXECUTE FUNCTION central_block_reconciliation_mutation()`;
    await hostile`UPDATE central_cooperative_reconciliations SET evidence = 'changed' WHERE request_id = 'decoy'`;
    expect(await hostile`SELECT evidence FROM central_cooperative_reconciliations WHERE request_id = 'decoy'`).toEqual([{ evidence: 'changed' }]);
    const [binding] = await admin<{ function_schema: string }[]>`SELECT n.nspname AS function_schema FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace table_ns ON table_ns.oid = c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE table_ns.nspname = ${schema} AND c.relname = 'central_cooperative_reconciliations' AND t.tgname = 'central_block_reconciliation_mutation'`;
    expect(binding?.function_schema).toBe(schema);
    await expect(hostile`UPDATE ${hostile(schema)}.central_cooperative_reconciliations SET evidence = 'tampered' WHERE request_id = 'request'`).rejects.toThrow(/immutable/);
    await expect(hostile`DELETE FROM ${hostile(schema)}.central_cooperative_reconciliations WHERE request_id = 'request'`).rejects.toThrow(/immutable/);
    expect(await db`SELECT evidence FROM central_cooperative_reconciliations WHERE request_id = 'request'`).toEqual([{ evidence: 'original' }]);
    expect(await hostile`SELECT * FROM central_cooperative_reconciliations`).toEqual([{ request_id: 'decoy', evidence: 'changed' }]);
  } finally {
    await Promise.all([db.close(), hostile.close()]);
    try {
      await admin`DROP SCHEMA ${admin(hostileSchema)} CASCADE`;
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
    } finally { await admin.close(); }
  }
});
