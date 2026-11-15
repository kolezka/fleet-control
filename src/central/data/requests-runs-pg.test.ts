import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralRequests } from "./requests.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "../test-database-url.ts";

// These tests leave rows in the supplied disposable database.
const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

integration("PostgreSQL returns only the named runs and pages through all of them in ID order", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const store = new CentralRequests(db);
  const prefix = "runs-" + crypto.randomUUID() + "-";
  const names = ["a", "b", "c", "d", "e"].map((name) => prefix + name);
  try {
    await store.initialize();
    for (const runId of names) await store.registerRun({ runId, orchestrator: "orch", phase: "plan" });

    expect((await store.runsById([names[3]!, names[1]!, names[3]!, prefix + "missing"])).map((run) => run.id)).toEqual([names[1]!, names[3]!]);
    expect(await store.runsById([])).toEqual([]);
    // A name with quotes and a wildcard is matched as text, not as a pattern or SQL.
    expect(await store.runsById(["%", "' OR '1'='1", prefix + "%"])).toEqual([]);
    await expect(store.runsById(["\ud800"])).rejects.toMatchObject({ kind: "invalid" });
    const one = (await store.runsById([names[0]!]))[0]!;
    expect(one).toMatchObject({ id: names[0]!, orchestrator: "orch", phase: "plan", revision: 1 });
    expect(typeof one.phaseStatus).toBe("string");
    expect(typeof one.updatedAt).toBe("string");

    const mine: string[] = [];
    let cursor: string | undefined;
    let previous = "";
    for (let pages = 0; pages < 10000; pages++) {
      const page = await store.listRuns({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      expect(page.runs.length).toBeLessThanOrEqual(2);
      for (const run of page.runs) {
        // Byte order, the order PostgreSQL uses for this cursor.
        expect(Buffer.compare(Buffer.from(run.id), Buffer.from(previous))).toBeGreaterThan(0);
        previous = run.id;
        if (run.id.startsWith(prefix)) mine.push(run.id);
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(mine).toEqual(names);
    await expect(store.listRuns({ limit: 0 })).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.listRuns({ limit: 1001 })).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.listRuns({ cursor: "not base64!" })).rejects.toMatchObject({ kind: "invalid" });
  } finally { await db.close(); }
});
