import { SQL, type TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { provisionCooperative } from "./cooperative-provision.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations, type CooperativeTransactionRunner } from "./incarnations.ts";
import { CentralCommands } from "./commands.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import { CooperativeInspection } from "./cooperative-inspection.ts";
import { CooperativeReconciliation } from "./cooperative-reconciliation.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;

pgTest("injected runner encloses each cooperative operation in one transaction", async () => {
  const parsed = new URL(url!);
  if (parsed.protocol !== "postgres:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "57507" || parsed.pathname !== "/fleet_control_test") throw new Error("refusing non-disposable test database");
  const db = new SQL({ url: url!, max: 1 });
  const schema = `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const shadowSchema = `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;
  let created = false;
  let shadowCreated = false;
  try {
    await provisionCooperative(db, { testSchema: schema });
    created = true;
    await db`CREATE SCHEMA ${db(shadowSchema)}`;
    shadowCreated = true;
    await db`CREATE TABLE ${db(shadowSchema)}.central_supervisor_identities_v2 (principal_id TEXT PRIMARY KEY, name TEXT NOT NULL, host_id TEXT NOT NULL, session TEXT NOT NULL, retired BOOLEAN NOT NULL DEFAULT FALSE)`;
    await db`INSERT INTO ${db(shadowSchema)}.central_supervisor_identities_v2 (principal_id, name, host_id, session) VALUES ('owner', 'owner', 'host', 'session')`;
    await db`SELECT pg_catalog.set_config('search_path', ${shadowSchema}, false)`;
    let calls = 0;
    let abort = false;
    const runner: CooperativeTransactionRunner = async <T>(operation: (tx: TransactionSQL) => Promise<T>): Promise<T> => {
      calls++;
      return db.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('search_path', ${schema}, true)`;
        const result = await operation(tx);
        if (abort) throw new Error("rollback requested");
        return result;
      });
    };
    const identity = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const identities = new SupervisorIdentityRegistry(db, runner);
    const incarnations = new SupervisorIncarnations(db, runner);
    const commands = new CentralCommands(db, undefined, runner);
    const claims = new CooperativeClaims(db, incarnations, undefined, runner);
    const lifecycle = new CooperativeLifecycle(db, incarnations, undefined, runner);
    const inspection = new CooperativeInspection(db, runner);
    const reconciliation = new CooperativeReconciliation(db, undefined, runner);
    const once = async <T>(action: () => Promise<T>) => { const before = calls; const result = await action(); expect(calls).toBe(before + 1); return result; };
    await once(() => identities.enroll(identity));
    expect(await once(() => identities.matches(identity))).toBe(true);
    const credential = await once(() => incarnations.activate(identity));
    const input = { idempotencyKey: "key", hostId: "host", target: "session", actor: "operator", text: "work" };
    abort = true;
    await expect(commands.submit(input)).rejects.toThrow("rollback requested");
    abort = false;
    expect((await once(() => commands.list())).commands).toHaveLength(0);
    const { command } = await once(() => commands.submit(input));
    expect((await once(() => commands.get(command.id))).id).toBe(command.id);
    expect((await once(() => claims.claim(identity, credential, "claim")))?.id).toBe(command.id);
    await once(() => lifecycle.report(identity, credential, command.id, "report", "accepted", "accepted"));
    const result = await once(() => inspection.inspect(command.id));
    expect(result?.events[0]?.status).toBe("accepted");
    const bounded = await once(() => inspection.inspectBounded(command.id, { limit: 1 }));
    expect(bounded).toEqual(result);
    const beforeInvalid = calls;
    await expect(inspection.inspectBounded(command.id, { limit: 5 })).rejects.toThrow("invalid limit");
    expect(calls).toBe(beforeInvalid);
    for (const table of ["central_command_event_lock", "central_cooperative_claims", "central_cooperative_lifecycle_events", "central_cooperative_reconciliations"]) {
      await db`CREATE TABLE ${db(shadowSchema)}.${db(table)} AS SELECT * FROM ${db(schema)}.${db(table)}`;
    }
    await db`INSERT INTO ${db(shadowSchema)}.central_cooperative_reconciliations (request_id, command_id, actor, disposition, evidence, sequence, at) VALUES ('assertion', ${command.id}, 'operator', 'failed', 'shadow', 1, 'shadow')`;
    const operator = { role: "operator" as const, name: "operator" };
    const [event] = await db<{ seq: string }[]>`SELECT seq::text AS seq FROM ${db(schema)}.central_cooperative_lifecycle_events WHERE command_id = ${command.id} ORDER BY seq DESC LIMIT 1`;
    const writeAssertion = (requestId: string) => reconciliation.reconcile(operator, command.id, requestId, "unknown", "evidence", event!.seq, null);
    abort = true;
    const beforeAbort = calls;
    await expect(writeAssertion("assertion")).rejects.toThrow("rollback requested");
    expect(calls).toBe(beforeAbort + 1);
    abort = false;
    expect(await db`SELECT request_id FROM ${db(schema)}.central_cooperative_reconciliations`).toHaveLength(0);
    const assertion = await once(() => writeAssertion("assertion"));
    expect(assertion).toMatchObject({ sequence: "1", supersedesSequence: null, evidence: "evidence" });
    expect(await once(() => writeAssertion("assertion"))).toEqual(assertion);
    await expect(once(() => reconciliation.reconcile(operator, command.id, "assertion", "failed", "evidence", event!.seq, null))).rejects.toThrow(/different intent/);
    await expect(once(() => writeAssertion("stale"))).rejects.toThrow(/stale assertion/);
    expect(await db`SELECT request_id, evidence FROM ${db(shadowSchema)}.central_cooperative_reconciliations`).toEqual([{ request_id: "assertion", evidence: "shadow" }]);
    await once(() => identities.retire(identity));
    expect(await once(() => identities.matches(identity))).toBe(false);
    const [shadow] = await db`SELECT retired FROM ${db(shadowSchema)}.central_supervisor_identities_v2 WHERE principal_id = ${identity.principalId}`;
    expect(shadow?.retired).toBe(false);
    await expect(claims.claim(identity, credential, "after-retirement")).rejects.toThrow("access denied");
    await expect(lifecycle.report(identity, credential, command.id, "after-retirement", "completed", "completed")).rejects.toThrow("access denied");
  } finally {
    if (shadowCreated) await db`DROP SCHEMA ${db(shadowSchema)} CASCADE`;
    if (created) await db`DROP SCHEMA ${db(schema)} CASCADE`;
    await db.close();
  }
});
