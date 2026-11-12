import { expect, test } from "bun:test";
import type { SQL, TransactionSQL } from "bun";
import { CentralCommands } from "./commands.ts";

const scope = { hostId: "host-a", session: "session-a" };

function fixture() {
  const queries: { sql: string; values: unknown[] }[] = [];
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?");
    queries.push({ sql, values });
    if (sql.includes("FROM central_commands")) return [{ id: values[0] }];
    if (sql.includes("FROM central_command_events")) return [];
    throw new Error(`Unexpected query: ${sql}`);
  }) as unknown as TransactionSQL;
  const db = Object.assign(tx, { begin: (operation: (connection: TransactionSQL) => unknown) => operation(tx) }) as unknown as SQL;
  return { store: new CentralCommands(db), queries };
}

test("eventsScoped filters events when an empty id matches", async () => {
  const { store, queries } = fixture();
  expect(await store.eventsScoped("", scope, async () => true, "7")).toEqual([]);
  expect(queries).toHaveLength(2);
  expect(queries[0]!.values).toEqual(["", "host-a", "session-a"]);
  expect(queries[1]!.sql).toContain("WHERE command_id = ? AND seq > ?::bigint");
  expect(queries[1]!.values).toEqual(["", "7"]);
});

test("events without an id preserves the global event query", async () => {
  const { store, queries } = fixture();
  expect(await store.events(undefined, "7")).toEqual([]);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).not.toContain("WHERE command_id =");
  expect(queries[0]!.values).toEqual(["7"]);
});

test("eventsScoped filters events for a matching known id", async () => {
  const { store, queries } = fixture();
  expect(await store.eventsScoped("command-a", scope, async () => true, "7")).toEqual([]);
  expect(queries).toHaveLength(2);
  expect(queries[0]!.values).toEqual(["command-a", "host-a", "session-a"]);
  expect(queries[1]!.sql).toContain("WHERE command_id = ? AND seq > ?::bigint");
  expect(queries[1]!.values).toEqual(["command-a", "7"]);
});
