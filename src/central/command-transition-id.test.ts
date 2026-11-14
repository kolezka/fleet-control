import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CommandError } from "../domain/commands.ts";
import { CentralCommands } from "./data/commands.ts";

const at = "2026-01-01T00:00:00.000Z";
const command = { id: "command-a", idempotencyKey: "key", hostId: "host", target: "session", actor: "owner", text: "work", status: "queued", createdAt: at, updatedAt: at };

function fixture() {
  let transactions = 0;
  const queries: { sql: string; values: unknown[] }[] = [];
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?");
    queries.push({ sql, values });
    if (sql.includes("FROM central_command_event_lock")) return [{ id: 1 }];
    if (sql.includes("FROM central_commands WHERE")) return values[0] === command.id ? [command] : [];
    if (sql.includes("UPDATE central_commands") || sql.includes("INSERT INTO central_command_events")) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  }) as unknown as TransactionSQL;
  const db = { begin: async (operation: (tx: TransactionSQL) => Promise<unknown>) => { transactions++; return operation(tx); } } as unknown as SQL;
  return { store: new CentralCommands(db, () => new Date(at)), queries, transactions: () => transactions };
}

for (const [name, id] of [["NUL", "command-\0suffix"], ["lone high surrogate", "command-\ud800"], ["lone low surrogate", "command-\udc00"]] as const) {
  test(`transition rejects ${name} before transaction or SQL`, async () => {
    const f = fixture();
    const error = await f.store.transition(id, "accepted", "supervisor", "accept").then(() => null, (error: unknown) => error);
    expect(f.transactions()).toBe(0);
    expect(f.queries).toEqual([]);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).kind).toBe("invalid");
    expect((error as CommandError).message).toBe("invalid command ID");
  });
}

test("transition accepts a normal ID and records the transition", async () => {
  const f = fixture();
  const result = await f.store.transition(command.id, "accepted", "supervisor", "accept");
  expect(result).toEqual({ ...command, status: "accepted", updatedAt: at });
  expect(f.transactions()).toBe(1);
  expect(f.queries.find(({ sql }) => sql.includes("FROM central_commands WHERE"))?.values).toEqual([command.id]);
  expect(f.queries.find(({ sql }) => sql.includes("UPDATE central_commands"))?.values).toEqual(["accepted", at, command.id]);
  expect(f.queries.find(({ sql }) => sql.includes("INSERT INTO central_command_events"))?.values).toEqual([command.id, "accepted", "supervisor", "accept", at]);
});

test("transition retains not-found and conflict errors for valid IDs", async () => {
  const f = fixture();
  const missing = await f.store.transition("missing", "accepted", "supervisor", "accept").then(() => null, (error: unknown) => error);
  expect(missing).toBeInstanceOf(CommandError);
  expect((missing as CommandError).kind).toBe("not_found");
  const conflict = await f.store.transition(command.id, "completed", "supervisor", "done").then(() => null, (error: unknown) => error);
  expect(conflict).toBeInstanceOf(CommandError);
  expect((conflict as CommandError).kind).toBe("conflict");
  expect(f.queries.some(({ sql }) => /^(UPDATE|INSERT)\b/.test(sql.trim()))).toBe(false);
});
