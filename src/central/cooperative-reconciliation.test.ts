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

test("bounded assertion reads reject non-string cursors before querying", async () => {
  const store = new CooperativeReconciliation({} as SQL, undefined, async () => { throw new Error("unexpected query"); });
  const operator = { role: "operator" as const, name: "operator" };
  for (const cursor of [1, { toString: () => "1" }]) {
    await expect(store.listBounded(operator, "command", { limit: 1, cursor: cursor as unknown as string })).rejects.toThrow("invalid cursor");
  }
});

test("reconciliation rejects malformed Unicode before opening a transaction", async () => {
  const store = new CooperativeReconciliation({} as SQL, undefined, async () => { throw new Error("unexpected transaction"); });
  const operator = { role: "operator" as const, name: "operator" };
  for (const invalid of ["bad\ud800", "bad\udc00"]) {
    await expect(store.reconcile(operator, "command", "request", "unknown", invalid, null, null)).rejects.toThrow("invalid reconciliation request");
    await expect(store.reconcile(operator, "command", invalid, "unknown", "evidence", null, null)).rejects.toThrow("invalid reconciliation request");
    await expect(store.reconcile(operator, invalid, "request", "unknown", "evidence", null, null)).rejects.toThrow("invalid reconciliation request");
    await expect(store.reconcile({ role: "operator", name: invalid }, "command", "request", "unknown", "evidence", null, null)).rejects.toThrow("access denied");
    await expect(store.list(operator, invalid)).rejects.toThrow("invalid command ID");
    await expect(store.listBounded(operator, invalid, { limit: 1 })).rejects.toThrow("invalid parameters");
  }
  await expect(store.reconcile({ role: "operator", name: "operator 🛰️" }, "command 🛰️", "request 🛰️", "unknown", "evidence 🛰️", null, null)).rejects.toThrow("unexpected transaction");
});

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
    await expect(write("bad-unicode", "unknown", null, null, "bad\ud800")).rejects.toThrow(/invalid/);
    await expect(write("bad\ud800", "unknown", null, null)).rejects.toThrow(/invalid/);
    await expect(store.reconcile(operator, "bad\ud800", "request", "unknown", "evidence", null, null)).rejects.toThrow(/invalid/);
    await expect(store.reconcile({ role: "operator", name: "bad\ud800" }, command.id, "request", "unknown", "evidence", null, null)).rejects.toThrow(/denied/);
    await expect(store.list(operator, "bad\ud800")).rejects.toThrow(/invalid/);
    await expect(store.listBounded(operator, "bad\ud800", { limit: 1 })).rejects.toThrow(/invalid/);
    expect(await db`SELECT request_id FROM central_cooperative_reconciliations`).toHaveLength(0);
    await expect(write("invalid", "unknown", "01", null)).rejects.toThrow(/invalid/);
    await expect(write("invalid-version", "unknown", null, "01")).rejects.toThrow(/invalid/);
    const same = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? store : rival).reconcile(operator, command.id, "same", "unknown", "evidence 🛰️", null, null)));
    expect(new Set(same.map((item) => JSON.stringify(item))).size).toBe(1);
    expect(same[0]).toMatchObject({ sequence: "1", supersedesSequence: null });
    await expect(write("same", "failed", null, null, "evidence 🛰️")).rejects.toThrow(/different intent/);
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
    expect(await write("same", "unknown", null, null, "evidence 🛰️")).toEqual(same[0]!);
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

pgTest("bounded assertion reads reject oversized database fields and the extra row", async () => {
  const admin = new SQL(url!);
  const schema = crypto.randomUUID().replaceAll("-", "");
  const name = `bounded_${schema}`;
  await admin`CREATE SCHEMA ${admin(name)}`;
  const db = new SQL(url!, { connection: { search_path: name } });
  try {
    await db`CREATE TABLE central_cooperative_claims (command_id TEXT PRIMARY KEY)`;
    await db`CREATE TABLE central_command_event_lock (id INTEGER PRIMARY KEY)`;
    await db`INSERT INTO central_command_event_lock VALUES (1)`;
    await db`INSERT INTO central_cooperative_claims VALUES ('command')`;
    const store = new CooperativeReconciliation(db);
    await store.initialize();
    const operator = { role: "operator" as const, name: "operator" };
    await db`INSERT INTO central_cooperative_reconciliations (request_id, command_id, actor, disposition, evidence, sequence, at) VALUES ('one', 'command', 'actor', 'unknown', 'ok', 1, 'now')`;
    for (const field of ["actor", "disposition", "evidence", "expected_sequence", "at"]) {
      await db.unsafe(`INSERT INTO central_cooperative_reconciliations (request_id, command_id, actor, disposition, evidence, sequence, at, ${field === "expected_sequence" ? "expected_sequence" : "supersedes_sequence"}) VALUES ('two', 'command', ${field === "actor" ? "repeat('x', 270337)" : "'actor'"}, ${field === "disposition" ? "repeat('x', 270337)" : "'unknown'"}, ${field === "evidence" ? "repeat('x', 270337)" : "'ok'"}, 2, ${field === "at" ? "repeat('x', 270337)" : "'now'"}, ${field === "expected_sequence" ? "repeat('x', 270337)" : "NULL"})`);
      await expect(store.listBounded(operator, 'command', { limit: 1 })).rejects.toThrow(/large/);
      await expect(store.listBounded(operator, 'command', { limit: 2 })).rejects.toThrow(/large/);
      await db`ALTER TABLE central_cooperative_reconciliations DISABLE TRIGGER central_block_reconciliation_mutation`;
      await db`DELETE FROM central_cooperative_reconciliations WHERE sequence = 2`;
      await db`ALTER TABLE central_cooperative_reconciliations ENABLE TRIGGER central_block_reconciliation_mutation`;
    }
    const observed: Record<string, unknown>[][] = [];
    const observingStore = new CooperativeReconciliation(db, undefined, (operation) => db.begin((tx) => {
      const wrapped = new Proxy(tx, {
        apply(target, thisArg, args) {
          return (async () => {
            const rows = await Reflect.apply(target, thisArg, args);
            observed.push(rows);
            return rows;
          })();
        }
      });
      return operation(wrapped);
    }));
    await db`INSERT INTO central_cooperative_claims VALUES ('edge'), ('overflow')`;
    const actor = "żółw";
    const evidence = "界".repeat(90000);
    for (const [commandId, requestId, sequence, extra] of [["edge", "edge-request", 1, 0], ["overflow", "overflow-request", 2, 1]] as const) {
      const fixedBytes = Buffer.byteLength(commandId + requestId + actor + "unknown" + evidence + "7" + String(sequence) + "1" + "now", "utf8");
      const sizedEvidence = evidence + "x".repeat(270336 + extra - fixedBytes);
      expect(Buffer.byteLength(commandId + requestId + actor + "unknown" + sizedEvidence + "7" + String(sequence) + "1" + "now", "utf8")).toBe(270336 + extra);
      await db`INSERT INTO central_cooperative_reconciliations (request_id, command_id, actor, disposition, evidence, expected_sequence, sequence, supersedes_sequence, at) VALUES (${requestId}, ${commandId}, ${actor}, 'unknown', ${sizedEvidence}, '7', ${sequence}, 1, 'now')`;
    }
    const edgePage = await observingStore.listBounded(operator, "edge", { limit: 1 });
    expect(edgePage?.assertions[0]).toMatchObject({ commandId: "edge", requestId: "edge-request", actor, disposition: "unknown", expectedSequence: "7", sequence: "1", supersedesSequence: "1", at: "now" });
    expect(edgePage?.assertions[0]?.evidence.startsWith(evidence)).toBe(true);
    expect(observed.at(-1)?.[0]).toMatchObject({ present: true, oversized: false, commandId: "edge", requestId: "edge-request", actor, disposition: "unknown", evidence: edgePage?.assertions[0]?.evidence, expectedSequence: "7", sequence: "1", supersedesSequence: "1", at: "now" });
    await expect(observingStore.listBounded(operator, "overflow", { limit: 1 })).rejects.toThrow(/large/);
    const masked = { present: true, oversized: true, commandId: null, requestId: null, actor: null, disposition: null, evidence: null, expectedSequence: null, sequence: null, supersedesSequence: null, at: null };
    expect(observed.at(-1)).toEqual([masked]);
    await db`INSERT INTO central_cooperative_reconciliations (request_id, command_id, actor, disposition, evidence, sequence, at) VALUES ('overflow-first', 'overflow', 'actor', 'unknown', 'ok', 1, 'now')`;
    await expect(observingStore.listBounded(operator, "overflow", { limit: 1 })).rejects.toThrow(/large/);
    const lookahead = observed.at(-1)!;
    expect(lookahead).toHaveLength(2);
    expect(lookahead[0]).toMatchObject({ oversized: false, requestId: "overflow-first", evidence: "ok", sequence: "1" });
    expect(lookahead[1]).toEqual(masked);
    expect((await store.listBounded(operator, 'command', { limit: 1 }))?.assertions[0]?.evidence).toBe('ok');
    expect(await store.listBounded(operator, 'missing', { limit: 1 })).toBeNull();
  } finally {
    await db.close();
    try { await admin`DROP SCHEMA ${admin(name)} CASCADE`; } finally { await admin.close(); }
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
