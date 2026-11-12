import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url.ts";

const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

integration("command cursors bind every filter across pages", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const hostId = `cursor-${crypto.randomUUID()}`;
  const store = new CentralCommands(db, () => new Date("2025-01-01T00:00:00.000Z"));
  const scope = { hostId, target: "session" };
  try {
    await store.initialize();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { command } = await store.submit({ idempotencyKey: `${hostId}-${i}`, ...scope, actor: "test", text: "test" });
      ids.push(command.id);
    }
    ids.sort();
    const first = await store.list("queued", scope, { limit: 1 });
    expect(first.commands.map((command) => command.id)).toEqual(ids.slice(0, 1));
    const cursor = first.nextCursor!;
    expect(cursor).toBeTruthy();
    const second = await store.list("queued", scope, { limit: 2, cursor });
    expect(second.commands.map((command) => command.id)).toEqual(ids.slice(1));
    expect(second.nextCursor).toBeNull();
    for (const [status, alteredScope] of [
      ["queued", { ...scope, hostId: `${hostId}-other` }],
      ["queued", { ...scope, target: "other" }],
      ["accepted", scope],
      [undefined, scope],
      ["queued", { hostId }],
      ["queued", { target: "session" }],
    ] as const) {
      await expect(store.list(status, alteredScope, { cursor })).rejects.toThrow(/invalid cursor/);
    }
    const unfiltered = await store.list(undefined, { hostId }, { limit: 1 });
    await expect(store.list("queued", { hostId }, { cursor: unfiltered.nextCursor! })).rejects.toThrow(/invalid cursor/);
    await expect(store.list(undefined, scope, { cursor: unfiltered.nextCursor! })).rejects.toThrow(/invalid cursor/);
    const oldCursor = Buffer.from(JSON.stringify([first.commands[0]!.createdAt, first.commands[0]!.id])).toString("base64url");
    await expect(store.list("queued", scope, { cursor: oldCursor })).rejects.toThrow(/invalid cursor/);
  } finally {
    await db`DELETE FROM central_command_events WHERE command_id IN (SELECT id FROM central_commands WHERE host_id = ${hostId})`;
    await db`DELETE FROM central_commands WHERE host_id = ${hostId}`;
    await db.close();
  }
});
