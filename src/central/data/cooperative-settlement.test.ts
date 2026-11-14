import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import { CooperativeInspection } from "./cooperative-inspection.ts";
import { CooperativeSettlement } from "./cooperative-settlement.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;
const operator = { role: "operator" as const, name: "operator" };

test("settlement validates input and role before opening a transaction", async () => {
  const store = new CooperativeSettlement({} as SQL, undefined, async () => { throw new Error("unexpected transaction"); });
  const supervisor = { role: "supervisor" as const, name: "s", principalId: "s", hostId: "h", session: "s" };
  await expect(store.settle(supervisor, "cmd", "req", "unknown", "evidence", null)).rejects.toThrow("access denied");
  await expect(store.get(supervisor, "cmd")).rejects.toThrow("access denied");
  for (const [disposition, evidence, expected] of [["retry", "e", null], ["unknown", "", null], ["unknown", " ", null], ["unknown", "bad\ud800", null], ["unknown", "e", "01"], ["unknown", "e", "9223372036854775808"], ["unknown", "e", 5]] as const) {
    await expect(store.settle(operator, "cmd", "req", disposition as never, evidence, expected as never)).rejects.toThrow("invalid settlement request");
  }
  await expect(store.settle(operator, "cmd", "req", "unknown", "evidence", "9223372036854775807")).rejects.toThrow("unexpected transaction");
});

pgTest("operator settles a claim only after its incarnation is inactive, once, without changing work state", async () => {
  const admin = new SQL(url!);
  const schema = `settlement_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema } });
  try {
    const supervisor = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const registry = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const lifecycle = new CooperativeLifecycle(db, incarnations);
    const store = new CooperativeSettlement(db, () => new Date("2026-11-12T00:00:00.000Z"));
    const inspection = new CooperativeInspection(db);
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize(); await claims.initialize(); await lifecycle.initialize(); await store.initialize();
    await registry.enroll(supervisor);
    const first = await incarnations.activate(supervisor);
    const { command } = await commands.submit({ idempotencyKey: "one", hostId: "host", target: "session", actor: "operator", text: "work" });
    await claims.claim(supervisor, first, "claim-one");
    await lifecycle.report(supervisor, first, command.id, "accept", "accepted", "accepted");
    const [{ seq }] = await db`SELECT seq::text AS seq FROM central_cooperative_lifecycle_events`;

    await expect(store.settle(operator, "missing", "s-missing", "unknown", "evidence", null)).rejects.toMatchObject({ kind: "not_found" });
    // A live incarnation can still report, so settlement is refused.
    await expect(store.settle(operator, command.id, "s-live", "unknown", "evidence", seq)).rejects.toThrow("claiming incarnation is still active");
    expect(await store.get(operator, command.id)).toBeNull();

    const second = await incarnations.activate(supervisor);
    await expect(lifecycle.report(supervisor, first, command.id, "run", "running", "late")).rejects.toThrow("access denied");
    await expect(store.settle(operator, command.id, "s-stale", "unknown", "evidence", null)).rejects.toThrow("stale lifecycle sequence");

    const snapshot = async () => ({
      command: await db`SELECT * FROM central_commands WHERE id = ${command.id}`,
      claim: await db`SELECT * FROM central_cooperative_claims WHERE command_id = ${command.id}`,
      events: await db`SELECT * FROM central_cooperative_lifecycle_events ORDER BY seq`,
      commandEvents: await db`SELECT * FROM central_command_events ORDER BY seq`,
    });
    const before = await snapshot();
    const result = await store.settle(operator, command.id, "s-one", "not-executed", "host journal shows no start", seq);
    expect(result).toEqual({ created: true, settlement: { commandId: command.id, requestId: "s-one", actor: "operator", disposition: "not-executed", evidence: "host journal shows no start", expectedSequence: seq, at: "2026-11-12T00:00:00.000Z" } });
    expect(await snapshot()).toEqual(before);
    expect(await store.get(operator, command.id)).toEqual(result.settlement);
    expect(await store.settle(operator, command.id, "s-one", "not-executed", "host journal shows no start", seq)).toEqual({ created: false, settlement: result.settlement });
    await expect(store.settle(operator, command.id, "s-one", "failed", "host journal shows no start", seq)).rejects.toThrow("different intent");
    await expect(store.settle({ role: "operator", name: "other" }, command.id, "s-one", "not-executed", "host journal shows no start", seq)).rejects.toThrow("different intent");
    await expect(store.settle(operator, command.id, "s-two", "completed", "other evidence", seq)).rejects.toThrow("claim is already settled");
    await expect(db`UPDATE central_cooperative_settlements SET disposition = 'completed'`).rejects.toThrow("settlement is immutable");
    await expect(db`DELETE FROM central_cooperative_settlements`).rejects.toThrow("settlement is immutable");
    await expect(db`INSERT INTO central_cooperative_settlements (command_id, request_id, actor, disposition, evidence, at) VALUES (${command.id}, 'raw', 'x', 'requeue', 'e', 'now')`).rejects.toThrow();
    expect((await inspection.inspect(command.id))?.claim).toMatchObject({ incarnationActive: false, settled: true });
    expect((await inspection.inspectBounded(command.id, { limit: 1 }))?.claim).toMatchObject({ incarnationActive: false, settled: true });
    expect((await commands.get(command.id)).status).toBe("claimed");
    // Settlement never makes the command claimable again.
    expect(await claims.claim(supervisor, second, "claim-again")).toBeNull();

    // A retired identity's still-active incarnation is frozen too, so its claim can be settled.
    const other = (await commands.submit({ idempotencyKey: "two", hostId: "host", target: "session", actor: "operator", text: "more" })).command;
    await claims.claim(supervisor, second, "claim-two");
    expect((await inspection.inspect(other.id))?.claim).toMatchObject({ incarnationActive: true, settled: false });
    await expect(store.settle(operator, other.id, "s-three", "unknown", "no evidence", null)).rejects.toThrow("still active");
    await registry.retire(supervisor);
    expect((await store.settle(operator, other.id, "s-three", "unknown", "no evidence", null)).created).toBe(true);
    expect((await inspection.inspect(other.id))?.claim).toMatchObject({ incarnationActive: false, settled: true });
  } finally {
    await db.close();
    await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
    await admin.close();
  }
});

pgTest("settlement refuses to run under a snapshot isolation level", async () => {
  const db = new SQL(url!);
  try {
    const store = new CooperativeSettlement(db, undefined, (operation) => db.begin(async (tx) => { await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`; return operation(tx); }) as never);
    await expect(store.settle(operator, "cmd", "req", "unknown", "evidence", null)).rejects.toThrow("settlement requires READ COMMITTED");
  } finally { await db.close(); }
});

pgTest("concurrent settlements of one claim produce exactly one record", async () => {
  const admin = new SQL(url!);
  const schema = `settlement_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin`CREATE SCHEMA ${admin(schema)}`;
  const db = new SQL(url!, { connection: { search_path: schema }, max: 4 });
  try {
    const supervisor = { role: "supervisor" as const, principalId: "owner", name: "owner", hostId: "host", session: "session" };
    const commands = new CentralCommands(db);
    const registry = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    const claims = new CooperativeClaims(db, incarnations);
    const store = new CooperativeSettlement(db);
    await commands.initialize(); await new CentralAttempts(db).initialize(); await registry.initialize(); await incarnations.initialize(); await claims.initialize(); await new CooperativeLifecycle(db, incarnations).initialize(); await store.initialize();
    await registry.enroll(supervisor);
    const credential = await incarnations.activate(supervisor);
    const { command } = await commands.submit({ idempotencyKey: "one", hostId: "host", target: "session", actor: "operator", text: "work" });
    await claims.claim(supervisor, credential, "claim");
    await incarnations.activate(supervisor);
    const results = await Promise.allSettled(["a", "b", "c", "d"].map((id) => store.settle(operator, command.id, id, "unknown", `evidence ${id}`, null)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toContain("already settled");
    expect(await db`SELECT count(*)::int AS n FROM central_cooperative_settlements`).toEqual([{ n: 1 }]);
  } finally {
    await db.close();
    await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
    await admin.close();
  }
});
