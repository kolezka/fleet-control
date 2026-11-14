import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CommandError } from "../domain/commands.ts";
import { CentralCommands } from "./data/commands.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url.ts";

const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

// Store-level scope rules must match list scope: nonempty after trim, at most 256 characters.
integration("submit validates hostId and target at the store boundary", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
  const run = crypto.randomUUID();
  const store = new CentralCommands(db);
  const hostIds: string[] = [];
  const base = { actor: "test", text: "test" };
  let n = 0;
  const attempt = (hostId: unknown, target: unknown) =>
    store.submit({ ...base, idempotencyKey: `${run}-${n++}`, hostId: hostId as string, target: target as string });
  const failures: string[] = [];
  const rejected = async (label: string, hostId: unknown, target: unknown) => {
    const error = await attempt(hostId, target).then(() => null, (e: unknown) => e);
    if (!(error instanceof CommandError) || error.kind !== "invalid") failures.push(`${label}: ${error === null ? "accepted" : String(error)}`);
  };
  const count = async () => {
    const [row] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM central_commands WHERE idempotency_key LIKE ${`${run}-%`}`;
    return row!.n;
  };
  try {
    await store.initialize();

    const good = `h-${run}`;
    hostIds.push(good);
    const invalid: [string, unknown, unknown][] = [
      ["empty hostId", "", "session"],
      ["blank hostId", " \t\n", "session"],
      ["hostId over 256", "h".repeat(257), "session"],
      ["non-string hostId", 5, "session"],
      ["missing hostId", undefined, "session"],
      ["null hostId", null, "session"],
      ["empty target", good, ""],
      ["blank target", good, "  "],
      ["target over 256", good, "t".repeat(257)],
      ["target over 256 by far", good, "t".repeat(5000)],
      ["target with bad characters", good, "bad target"],
      ["non-string target", good, 5],
      ["missing target", good, undefined],
      ["null target", good, null],
    ];
    for (const [label, hostId, target] of invalid) await rejected(label, hostId, target);
    // Nothing from the rejected calls may reach the table.
    expect({ failures, stored: await count() }).toEqual({ failures: [], stored: 0 });

    // Boundary: exactly 256 is accepted for both fields and is listable with the same scope.
    const longHost = `${run}-`.padEnd(256, "h");
    const longTarget = "t".repeat(256);
    hostIds.push(longHost);
    expect(longHost.length).toBe(256);
    const { command, created } = await attempt(longHost, longTarget);
    expect(created).toBe(true);
    expect(command.hostId).toBe(longHost);
    expect(command.target).toBe(longTarget);
    const listed = await store.list(undefined, { hostId: longHost, target: longTarget });
    expect(listed.commands.map((item) => item.id)).toEqual([command.id]);
    expect(await count()).toBe(1);

    // One past the boundary is rejected for each field on its own.
    await rejected("hostId 257 with valid target", "h".repeat(257), longTarget);
    await rejected("target 257 with valid host", longHost, "t".repeat(257));
    expect({ failures, stored: await count() }).toEqual({ failures: [], stored: 1 });

    // A valid command still works after the rejections.
    expect((await attempt(good, "session")).created).toBe(true);
    expect(await count()).toBe(2);
  } finally {
    const ids = db`SELECT id FROM central_commands WHERE idempotency_key LIKE ${`${run}-%`}`;
    await db`DELETE FROM central_command_events WHERE command_id IN (${ids})`;
    await db`DELETE FROM central_commands WHERE idempotency_key LIKE ${`${run}-%`}`;
    await db.close();
  }
});
