import { SQL, type TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url.ts";
import { provisionCooperative } from "./cooperative-provision.ts";
import type { CooperativeTransactionRunner } from "./incarnations.ts";

const url = centralTestDatabaseUrl(process.env);
const pgTest = url ? test : test.skip;

pgTest("bounded operator reads mask returned rows and preserve cursors across oversized lookahead", async () => {
  const parsed = new URL(url!);
  if (parsed.protocol !== "postgres:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "57507" || parsed.pathname !== "/fleet_control_test") throw new Error("refusing non-disposable test database");
  const db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL({ url: currentUrl, max: 1 }));
  const schema = `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;
  let created = false;
  try {
    await provisionCooperative(db, { testSchema: schema });
    created = true;
    let calls = 0;
    const runner: CooperativeTransactionRunner = async <T>(operation: (tx: TransactionSQL) => Promise<T>): Promise<T> => {
      calls++;
      return db.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('search_path', ${schema}, true)`;
        return operation(tx);
      });
    };
    const commands = new CentralCommands(db, undefined, runner);
    for (let i = 0; i < 6; i++) await commands.submit({ idempotencyKey: `key-${i}`, hostId: "host", target: "session", actor: "operator", text: "work" });
    let before = calls;
    const page = await commands.listBounded(undefined, { hostId: "host" }, { limit: 4 });
    expect(calls).toBe(before + 1);
    expect(page.commands).toHaveLength(4);
    expect(page.nextCursor).not.toBeNull();
    const next = await commands.listBounded(undefined, { hostId: "host" }, { limit: 4, cursor: page.nextCursor! });
    expect(next.commands).toHaveLength(2);
    expect(new Set([...page.commands, ...next.commands].map((row) => row.id)).size).toBe(6);
    expect(next.nextCursor).toBeNull();
    await expect(commands.listBounded(undefined, { hostId: "other" }, { cursor: page.nextCursor! })).rejects.toThrow("invalid cursor");
    await expect(commands.listBounded(undefined, undefined, { limit: 5 })).rejects.toThrow("invalid limit");
    for (const [hostId, id, createdAt] of [
      ["bad-id", "not-a-command-id", "2020-01-01T00:00:00.000Z"],
      ["bad-date", "cmd-00000000-0000-0000-0000-000000000001", "2020-01-01T00:00:00Z"],
    ]) {
      await db`INSERT INTO ${db(schema)}.central_commands (id, idempotency_key, host_id, target, actor, text, status, created_at, updated_at) VALUES (${id!}, ${hostId!}, ${hostId!}, 'session', 'operator', 'work', 'queued', ${createdAt!}, ${createdAt!})`;
      await commands.submit({ idempotencyKey: `${hostId}-next`, hostId: hostId!, target: "session", actor: "operator", text: "work" });
      await expect(commands.listBounded(undefined, { hostId }, { limit: 1 })).rejects.toThrow("invalid cursor");
    }
    before = calls;
    expect(await commands.getBounded(page.commands[0]!.id)).toEqual(page.commands[0]!);
    expect(calls).toBe(before + 1);
    const lookahead = next.commands[0]!;
    await db`UPDATE ${db(schema)}.central_commands SET actor = repeat('é', 140000) WHERE id = ${lookahead.id}`;
    await expect(commands.getBounded(lookahead.id)).rejects.toThrow("command read too large");
    const preceding = await commands.listBounded(undefined, { hostId: "host" }, { limit: 4 });
    expect(preceding).toEqual(page);
    await expect(commands.listBounded(undefined, { hostId: "host" }, { limit: 4, cursor: preceding.nextCursor! })).rejects.toThrow("command read too large");
    expect((await commands.get(lookahead.id)).actor.length).toBe(140000);
    expect((await commands.list(undefined, { hostId: "host" }, { limit: 6 })).commands).toHaveLength(6);
  } finally {
    if (created) await db`DROP SCHEMA ${db(schema)} CASCADE`;
    await db.close();
  }
});
