import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralRequests } from "./requests.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "../test-database-url.ts";

// These tests leave rows in the supplied disposable database.
const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

for (const field of ["evidence", "allowedResponses"] as const) {
  const column = field === "evidence" ? "evidence" : "allowed_responses";

  integration("PostgreSQL stores no row for a malformed " + field + " array", async () => {
    const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
    const store = new CentralRequests(db);
    const runId = "test-" + crypto.randomUUID();
    const base = { runId, origin: "orch", expectedRevision: 1, kind: "approval" as const, question: "Proceed?" };
    try {
      await store.initialize();
      await store.registerRun({ runId, orchestrator: "orch", phase: "plan" });
      const written = async () => ({
        requests: (await db`SELECT id FROM central_requests WHERE run_id = ${runId}`).length,
        events: (await db`SELECT seq FROM central_request_events WHERE run_id = ${runId}`).length,
      });
      const before = await written();
      const sparse = ["first", "second", "third"];
      delete sparse[1];
      const leading = new Array<string>(2);
      leading[1] = "present";
      for (const values of [sparse, leading, [null] as unknown as string[], ["\ud800"]]) {
        await expect(store.create({ ...base, [field]: values })).rejects.toMatchObject({ kind: "invalid" });
        expect(await written()).toEqual(before);
      }
    } finally { await db.close(); }
  });

  integration("PostgreSQL round-trips a dense " + field + " array and ignores its toJSON", async () => {
    const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
    const store = new CentralRequests(db);
    const runId = "test-" + crypto.randomUUID();
    const base = { runId, origin: "orch", expectedRevision: 1, kind: "approval" as const, question: "Proceed?" };
    try {
      await store.initialize();
      await store.registerRun({ runId, orchestrator: "orch", phase: "plan" });
      const values = ["plain", "proof \u{1F600}"];
      const holes = new Array<string>(2);
      holes[1] = "replaced";
      Object.defineProperty(values, "toJSON", { value: () => holes });
      const created = await store.create({ ...base, [field]: values });
      expect(created[field]).toEqual(["plain", "proof \u{1F600}"]);
      const [row] = await db`SELECT ${db(column)} AS stored FROM central_requests WHERE id = ${created.id}`;
      expect(row.stored).toBe(JSON.stringify(["plain", "proof \u{1F600}"]));
      expect(await store.get(created.id)).toEqual(created);
    } finally { await db.close(); }
  });
}

integration("PostgreSQL rows written with null holes stay readable and are not repaired", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const store = new CentralRequests(db);
  const runId = "test-" + crypto.randomUUID();
  try {
    await store.initialize();
    await store.registerRun({ runId, orchestrator: "orch", phase: "plan" });
    const created = await store.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    await db`UPDATE central_requests SET evidence = '[null,"kept"]', allowed_responses = '[null,"approve"]' WHERE id = ${created.id}`;
    const read = await store.get(created.id);
    expect(read.evidence as unknown).toEqual([null, "kept"]);
    expect(read.allowedResponses as unknown).toEqual([null, "approve"]);
    const [row] = await db`SELECT evidence, allowed_responses FROM central_requests WHERE id = ${created.id}`;
    expect(row).toEqual({ evidence: '[null,"kept"]', allowed_responses: '[null,"approve"]' });
  } finally { await db.close(); }
});
