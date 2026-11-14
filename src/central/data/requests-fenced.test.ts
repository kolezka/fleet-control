import { SQL } from "bun";
import { expect, test } from "bun:test";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "../test-database-url.ts";
import { CentralRequests, type RequestMutationGuard } from "./requests.ts";

const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

integration("guards run in the mutation transaction, before locks, and roll back on denial", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const store = new CentralRequests(db);
  const runId = `fenced-${crypto.randomUUID()}`;
  const rejectedRunId = `fenced-${crypto.randomUUID()}`;
  try {
    await store.initialize();
    await store.registerRun({ runId, orchestrator: "owner", phase: "plan" });
    const resolved = await store.create({ runId, origin: "owner", expectedRevision: 1, kind: "approval", question: "Resolved?" });
    await store.resolve({ requestId: resolved.id, actor: "operator", response: "approve", expectedRevision: 1 });
    const open = await store.create({ runId, origin: "owner", expectedRevision: 1, kind: "approval", question: "Open?" });
    const before = (await store.events()).filter((event) => event.runId === runId || event.runId === rejectedRunId);
    let calls = 0;
    const reject: RequestMutationGuard = async (tx) => {
      calls++;
      await other.begin(async (probe) => {
        await probe`SELECT id FROM central_request_event_lock WHERE id = 1 FOR UPDATE NOWAIT`;
      });
      await tx`INSERT INTO central_runs VALUES (${rejectedRunId}, 'guard', 'test', 1, 'planned', 'now')`;
      throw new Error("guard rejected");
    };
    const attempts = [
      () => store.registerRun({ runId: rejectedRunId, orchestrator: "owner", phase: "plan" }, reject),
      () => store.updatePhase({ runId, actor: "owner", expectedRevision: 1, phaseStatus: "active", newRevision: true }, reject),
      () => store.create({ runId, origin: "owner", expectedRevision: 1, kind: "approval", question: "Denied?" }, reject),
      () => store.acknowledge({ requestId: resolved.id, actor: "owner" }, reject),
      () => store.withdraw({ requestId: open.id, actor: "owner", reason: "Denied" }, reject),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow("guard rejected");
    expect(calls).toBe(5);
    expect((await db`SELECT id FROM central_runs WHERE id = ${rejectedRunId}`)).toHaveLength(0);
    expect((await store.run(runId)).revision).toBe(1);
    expect((await store.get(resolved.id)).status).toBe("resolved");
    expect((await store.get(open.id)).status).toBe("open");
    expect((await store.events()).filter((event) => event.runId === runId || event.runId === rejectedRunId)).toEqual(before);

    const marker = `fenced-${crypto.randomUUID()}`;
    const writingGuard: RequestMutationGuard = async (tx) => {
      await tx`INSERT INTO central_runs VALUES (${marker}, 'guard', 'test', 1, 'planned', 'now')`;
    };
    await expect(store.create({ runId, origin: "intruder", expectedRevision: 1, kind: "approval", question: "Denied?" }, writingGuard)).rejects.toMatchObject({ kind: "forbidden", message: "access denied" });
    expect(await db`SELECT id FROM central_runs WHERE id = ${marker}`).toHaveLength(0);
    const allow: RequestMutationGuard = async (tx) => { await tx`SELECT 1`; };
    for (const attempt of [
      () => store.registerRun({ runId, orchestrator: "intruder", phase: "plan" }, allow),
      () => store.updatePhase({ runId, actor: "intruder", expectedRevision: 1, phaseStatus: "active", newRevision: true }, allow),
      () => store.create({ runId, origin: "intruder", expectedRevision: 1, kind: "approval", question: "Denied?" }, allow),
      () => store.acknowledge({ requestId: resolved.id, actor: "intruder" }, allow),
      () => store.withdraw({ requestId: open.id, actor: "intruder", reason: "Denied" }, allow),
    ]) await expect(attempt()).rejects.toMatchObject({ kind: "forbidden", message: "access denied" });
    expect((await store.events()).filter((event) => event.runId === runId || event.runId === rejectedRunId)).toEqual(before);
    expect((await store.acknowledge({ requestId: resolved.id, actor: "owner" }, allow)).status).toBe("acknowledged");
    expect((await store.withdraw({ requestId: open.id, actor: "owner", reason: "Done" }, allow)).status).toBe("withdrawn");
    const newRun = `fenced-${crypto.randomUUID()}`;
    expect((await store.registerRun({ runId: newRun, orchestrator: "owner", phase: "plan" }, writingGuard)).id).toBe(newRun);
    expect(await db`SELECT id FROM central_runs WHERE id = ${marker}`).toHaveLength(1);
    expect((await store.create({ runId: newRun, origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?" }, allow)).status).toBe("open");
    expect((await store.updatePhase({ runId: newRun, actor: "owner", expectedRevision: 1, phaseStatus: "active", newRevision: true }, allow)).run.revision).toBe(2);
  } finally {
    await db.close();
    await other.close();
  }
});
