import { SQL } from "bun";
import { expect, test } from "bun:test";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "../test-database-url.ts";
import { CentralRequests } from "./requests.ts";

test("scoped gate requires a guard before reading owner and decision", async () => {
  const calls: string[] = [];
  const db = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("central_request_event_lock")) { calls.push("event lock"); return Promise.resolve([{ id: 1 }]); }
    if (query.includes("FROM central_runs")) { calls.push("owner"); return Promise.resolve([{ id: "run", orchestrator: "owner", phase: "plan", revision: 1 }]); }
    if (query.includes("FROM central_requests")) { calls.push("decision"); return Promise.resolve([{ id: "approval", status: "resolved", response: "approve", resolvedBy: "human" }]); }
    return Promise.resolve([]);
  }) as unknown as SQL;
  db.begin = (async (fn: (tx: SQL) => Promise<unknown>) => fn(db)) as typeof db.begin;
  const store = new CentralRequests(db);
  const guard = async (tx: SQL) => { expect(tx).toBe(db); calls.push("guard"); };
  expect(await store.gateScoped("run", "plan", 1, "owner", guard)).toEqual({ approved: true, reason: "approved by human", requestId: "approval" });
  expect(calls).toEqual(["guard", "event lock", "owner", "decision"]);
  calls.length = 0;
  await expect(store.gateScoped("run", "plan", 1, "intruder", guard)).rejects.toMatchObject({ kind: "forbidden", message: "access denied" });
  expect(calls).toEqual(["guard", "event lock", "owner"]);
  calls.length = 0;
  await expect(store.gateScoped("run", "plan", 1, "owner", undefined as never)).rejects.toThrow();
  expect(calls).toEqual([]);
});

const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

integration("scoped gate fences before owner and decision and rolls back guard writes on denial", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const store = new CentralRequests(db);
  const runId = `gate-fenced-${crypto.randomUUID()}`, marker = `gate-marker-${crypto.randomUUID()}`;
  try {
    await store.initialize();
    await store.registerRun({ runId, orchestrator: "owner", phase: "plan" });
    const request = await store.create({ runId, origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    await store.resolve({ requestId: request.id, actor: "human", response: "approve", expectedRevision: 1 });
    let calls = 0;
    const guard = async (tx: SQL) => {
      calls++;
      await other.begin(async (probe) => {
        await probe`SELECT id FROM central_request_event_lock WHERE id = 1 FOR UPDATE NOWAIT`;
        await probe`SELECT id FROM central_runs WHERE id = ${runId} FOR UPDATE NOWAIT`;
      });
      await tx`INSERT INTO central_runs VALUES (${marker}, 'guard', 'test', 1, 'planned', 'now')`;
    };
    await expect(store.gateScoped(runId, "plan", 1, "intruder", guard)).rejects.toMatchObject({ kind: "forbidden", message: "access denied" });
    expect(await db`SELECT id FROM central_runs WHERE id = ${marker}`).toHaveLength(0);
    await expect(store.gateScoped(runId, "plan", 1, "owner", async (tx) => {
      await tx`INSERT INTO central_runs VALUES (${marker}, 'guard', 'test', 1, 'planned', 'now')`;
      throw new Error("guard rejected");
    })).rejects.toThrow("guard rejected");
    expect(await db`SELECT id FROM central_runs WHERE id = ${marker}`).toHaveLength(0);
    expect(await store.gateScoped(runId, "plan", 1, "owner", guard)).toEqual(await store.gate(runId, "plan", 1));
    expect(calls).toBe(2);
    expect(await db`SELECT id FROM central_runs WHERE id = ${marker}`).toHaveLength(1);
    expect(await store.gateScoped(runId, "other", 1, "owner", async () => {})).toEqual(await store.gate(runId, "other", 1));
  } finally {
    await db.close();
    await other.close();
  }
});
