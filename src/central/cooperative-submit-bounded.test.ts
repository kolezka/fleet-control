import { SQL, type TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";
import { provisionCooperative } from "./cooperative-provision.ts";
import type { CooperativeTransactionRunner } from "./incarnations.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = url ? test : test.skip;

pgTest("bounded submit preserves replay and rejects oversized existing rows without exposing fields", async () => {
  const parsed = new URL(url!);
  if (parsed.protocol !== "postgres:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "57507" || parsed.pathname !== "/fleet_control_test") throw new Error("refusing non-disposable test database");
  const db = new SQL({ url: url!, max: 1 });
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
    const input = { idempotencyKey: "key", hostId: "host", target: "session", actor: "operator", text: " work " };
    const first = await commands.submitBounded(input);
    expect(first.created).toBe(true);
    expect(first.command.text).toBe("work");
    expect(await commands.submitBounded(input)).toEqual({ command: first.command, created: false });
    expect(calls).toBe(2);
    await expect(commands.submitBounded({ ...input, text: "different" })).rejects.toThrow("idempotency key was used for a different command");
    await db`UPDATE ${db(schema)}.central_commands SET actor = repeat('é', 140000) WHERE id = ${first.command.id}`;
    await expect(commands.submitBounded(input)).rejects.toThrow("command read too large");
    await expect(commands.submitBounded({ ...input, text: "different" })).rejects.toThrow("command read too large");
    expect((await commands.get(first.command.id)).actor.length).toBe(140000);
    const events = await db`SELECT count(*)::int AS count FROM ${db(schema)}.central_command_events`;
    expect(events[0]!.count).toBe(1);
  } finally {
    if (created) await db`DROP SCHEMA ${db(schema)} CASCADE`;
    await db.close();
  }
});
