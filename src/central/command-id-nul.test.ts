import { expect, test } from "bun:test";
import type { SQL, TransactionSQL } from "bun";
import { CentralCommands } from "./commands.ts";
import { CommandError } from "../commands.ts";
import type { CooperativeTransactionRunner } from "./incarnations.ts";

const scope = { hostId: "host-a", session: "session-a" };
const command = { id: "command-a", hostId: scope.hostId, target: scope.session, status: "queued", idempotencyKey: "key", actor: "operator", text: "text", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" };
type Method = "get" | "getBounded" | "events" | "getScoped" | "transitionScoped" | "eventsScoped";

function fixture(useRunner: boolean) {
  const queries: { sql: string; values: unknown[] }[] = [];
  let guards = 0;
  let transactions = 0;
  let runners = 0;
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?");
    queries.push({ sql, values });
    if (sql.includes("FROM central_command_event_lock")) return [{ id: 1 }];
    if (sql.includes("FROM central_commands WHERE")) return sql.includes("json_build_object") ? [{ command }] : [command];
    return [];
  }) as unknown as TransactionSQL;
  const db = Object.assign(tx, { begin: (operation: (connection: TransactionSQL) => unknown) => { transactions++; return operation(tx); } }) as unknown as SQL;
  const runner: CooperativeTransactionRunner = (operation) => { runners++; return operation(tx); };
  const store = new CentralCommands(db, undefined, useRunner ? runner : undefined);
  const guard = async () => { guards++; return true; };
  const invoke = (method: Method, id: string) => {
    switch (method) {
      case "get": return store.get(id);
      case "getBounded": return store.getBounded(id);
      case "events": return store.events(id);
      case "getScoped": return store.getScoped(id, scope, guard);
      case "transitionScoped": return store.transitionScoped(id, "accepted", "supervisor", "accept", scope, guard);
      case "eventsScoped": return store.eventsScoped(id, scope, guard);
    }
  };
  return { invoke, queries, counts: () => ({ guards, transactions, runners }) };
}

for (const method of ["get", "getBounded", "events", "getScoped", "transitionScoped", "eventsScoped"] as const) {
  for (const useRunner of [false, true]) {
    test(`${method} rejects NUL before SQL, transaction or guard (runner=${useRunner})`, async () => {
      const { invoke, queries, counts } = fixture(useRunner);
      const failure = await invoke(method, "command-\0suffix").then(() => null, (error: unknown) => error);
      if (!(failure instanceof Error)) throw new Error("expected an error");
      if (method.endsWith("Scoped")) {
        expect(failure).toBeInstanceOf(Error);
        expect(failure.message).toBe("access denied");
        expect(failure).not.toBeInstanceOf(CommandError);
      } else {
        expect(failure).toBeInstanceOf(CommandError);
        if (!(failure instanceof CommandError)) throw failure;
        expect(failure.kind).toBe("invalid");
        expect(failure.message).toBe("invalid command ID");
      }
      expect(queries).toEqual([]);
      expect(counts()).toEqual({ guards: 0, transactions: 0, runners: 0 });
    });
    test(`${method} accepts a normal ID (runner=${useRunner})`, async () => {
      const { invoke, queries, counts } = fixture(useRunner);
      await invoke(method, command.id);
      expect(queries.some(({ values }) => values.includes(command.id))).toBe(true);
      const scoped = method.endsWith("Scoped");
      // With a runner, every operation runs inside it instead of its own transaction.
      expect(counts()).toEqual({ guards: scoped ? 1 : 0, transactions: scoped && !useRunner ? 1 : 0, runners: useRunner ? 1 : 0 });
    });
  }
}
