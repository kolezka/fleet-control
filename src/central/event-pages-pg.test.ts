import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./data/commands.ts";
import { CentralRequests } from "./data/requests.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url.ts";

const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

// Event reads take an optional page size; without one they still return everything after the cursor.
integration("PostgreSQL command events page by seq and stay complete without a limit", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const hostId = `event-pages-${crypto.randomUUID()}`;
  const store = new CentralCommands(db);
  try {
    await store.initialize();
    const { command } = await store.submit({ idempotencyKey: hostId, hostId, target: "session", actor: "test", text: "test" });
    await store.transition(command.id, "accepted", "test", "one");
    await store.transition(command.id, "running", "test", "two");
    const all = await store.events(command.id);
    expect(all.map((event) => event.status)).toEqual(["queued", "accepted", "running"]);
    const first = await store.events(command.id, "0", 2);
    expect(first).toEqual(all.slice(0, 2));
    expect(await store.events(command.id, first.at(-1)!.seq, 2)).toEqual(all.slice(2));
    const global = await store.events(undefined, String(BigInt(all[0]!.seq) - 1n), 1);
    expect(global).toEqual(all.slice(0, 1));
    for (const limit of [0, 1001, 1.5, Number.NaN]) await expect(store.events(command.id, "0", limit)).rejects.toMatchObject({ kind: "invalid" });
  } finally {
    await db`DELETE FROM central_command_events WHERE command_id IN (SELECT id FROM central_commands WHERE host_id = ${hostId})`;
    await db`DELETE FROM central_commands WHERE host_id = ${hostId}`;
    await db.close();
  }
});

// This test leaves its run and request rows in the supplied disposable database.
integration("PostgreSQL request events page by seq and stay complete without a limit", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const store = new CentralRequests(db);
  try {
    await store.initialize();
    const [{ max }] = await db`SELECT coalesce(max(seq), 0)::text AS max FROM central_request_events`;
    const runId = `event-pages-${crypto.randomUUID()}`;
    await store.registerRun({ runId, orchestrator: "orchestrator", phase: "one" });
    await store.create({ runId, origin: "orchestrator", expectedRevision: 1, kind: "clarification", question: "q" });
    const all = (await store.events(max)).filter((event) => event.runId === runId);
    expect(all.length).toBeGreaterThanOrEqual(1);
    const page = await store.events(max, 1);
    expect(page).toHaveLength(1);
    for (const limit of [0, 1001]) await expect(store.events(max, limit)).rejects.toMatchObject({ kind: "invalid" });
  } finally {
    await db.close();
  }
});
