import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./data/commands.ts";
import { CentralRequests } from "./data/requests.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url.ts";

const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;
const malformed = [["NUL", "bad\0text"], ["high surrogate", "bad\ud800text"], ["low surrogate", "bad\udc00text"]] as const;

// PostgreSQL would refuse the NUL with its own error and store a lone
// surrogate as U+FFFD, so the store has to reject both before it writes.
integration("PostgreSQL keeps a command unchanged when a transition has malformed event text", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const hostId = `event-encoding-${crypto.randomUUID()}`;
  const store = new CentralCommands(db);
  try {
    await store.initialize();
    const { command } = await store.submit({ idempotencyKey: hostId, hostId, target: "session", actor: "test", text: "test" });
    for (const [, value] of malformed) {
      await expect(store.transition(command.id, "accepted", value, "accepted")).rejects.toMatchObject({ kind: "invalid" });
      await expect(store.transition(command.id, "accepted", "test", value)).rejects.toMatchObject({ kind: "invalid" });
    }
    expect((await store.get(command.id)).status).toBe("queued");
    expect((await store.events(command.id)).map((event) => event.status)).toEqual(["queued"]);
    expect((await store.transition(command.id, "accepted", "test 😀", "accepted 🚀")).status).toBe("accepted");
    expect((await store.events(command.id)).at(-1)).toMatchObject({ status: "accepted", actor: "test 😀", detail: "accepted 🚀" });
  } finally {
    await db`DELETE FROM central_command_events WHERE command_id IN (SELECT id FROM central_commands WHERE host_id = ${hostId})`;
    await db`DELETE FROM central_commands WHERE host_id = ${hostId}`;
    await db.close();
  }
});

// This test leaves its run and request rows in the supplied disposable database.
integration("PostgreSQL keeps a request open when a withdrawal reason is malformed", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const runId = `event-encoding-${crypto.randomUUID()}`;
  const store = new CentralRequests(db);
  try {
    await store.initialize();
    await store.registerRun({ runId, orchestrator: "orch", phase: "plan" });
    const request = await store.create({ runId, origin: "orch", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    const events = async () => (await db<{ kind: string; detail: string }[]>`SELECT kind, detail FROM central_request_events WHERE request_id = ${request.id} ORDER BY seq`).map((event) => ({ ...event }));
    const before = await events();
    for (const [, reason] of malformed) {
      await expect(store.withdraw({ requestId: request.id, actor: "orch", reason })).rejects.toMatchObject({ kind: "invalid" });
    }
    expect((await store.get(request.id)).status).toBe("open");
    expect(await events()).toEqual(before);
    expect((await store.withdraw({ requestId: request.id, actor: "orch", reason: "not needed 😀" })).status).toBe("withdrawn");
    expect((await events()).at(-1)).toEqual({ kind: "withdrawn", detail: "not needed 😀" });
  } finally {
    await db.close();
  }
});
