import { expect, test } from "bun:test";
import type { SQL, TransactionSQL } from "bun";
import { CommandError } from "../commands.ts";
import { CentralCommands, type SupervisorCommandScope } from "./commands.ts";
import type { CooperativeTransactionRunner } from "./incarnations.ts";

function fixture() {
  const queries: { sql: string; values: unknown[] }[] = [];
  const scopes: SupervisorCommandScope[] = [];
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ sql: parts.join("?"), values });
    return [];
  }) as unknown as TransactionSQL;
  const db = Object.assign(tx, { begin: (operation: (connection: TransactionSQL) => unknown) => operation(tx) }) as unknown as SQL;
  const runner: CooperativeTransactionRunner = (operation) => operation(tx);
  const guard = async (_tx: TransactionSQL, scope: SupervisorCommandScope) => {
    scopes.push(scope);
    return true;
  };
  return { store: new CentralCommands(db, undefined, runner), guard, queries, scopes };
}

for (const method of ["list", "listBounded", "listScoped"] as const) {
  for (const field of ["hostId", "target"] as const) {
    test(`${method} rejects NUL in ${field} before the data query`, async () => {
      const { store, guard, queries } = fixture();
      const scope = { hostId: "host-a", target: "session-a", [field]: "bad\0value" };
      const result = method === "listScoped"
        ? store.listScoped(undefined, { hostId: scope.hostId, session: scope.target }, guard)
        : store[method](undefined, scope);
      const error = await result.then(() => null, (reason: unknown) => reason);
      expect({ rejected: error instanceof Error, kind: error instanceof CommandError ? error.kind : null, message: error instanceof Error ? error.message : null, queries }).toEqual({
        rejected: true,
        kind: method === "listScoped" ? null : "invalid",
        message: method === "listScoped" ? "access denied" : "invalid scope",
        queries: [],
      });
    });
  }

  test(`${method} queries a valid host and target`, async () => {
    const { store, guard, queries, scopes } = fixture();
    const scope = { hostId: "host-a", target: "session-a" };
    const page = method === "listScoped"
      ? await store.listScoped("queued", { hostId: scope.hostId, session: scope.target }, guard)
      : await store[method]("queued", scope);
    expect(page).toEqual({ commands: [], nextCursor: null });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("central_commands");
    expect(queries[0]!.values.slice(0, 6)).toEqual(["host-a", "host-a", "session-a", "session-a", "queued", "queued"]);
    expect(scopes).toEqual(method === "listScoped" ? [{ hostId: "host-a", session: "session-a" }] : []);
  });
}
