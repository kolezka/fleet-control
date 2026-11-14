import { expect, test } from "bun:test";
import type { SQL, TransactionSQL } from "bun";
import { CentralCommands, type SupervisorCommandScope } from "./data/commands.ts";

function fixture() {
  const queries: unknown[][] = [];
  const scopes: SupervisorCommandScope[] = [];
  const tx = (async (_parts: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(values);
    return [];
  }) as unknown as TransactionSQL;
  const db = { begin: (operation: (connection: TransactionSQL) => unknown) => operation(tx) } as unknown as SQL;
  const guard = async (_tx: TransactionSQL, scope: SupervisorCommandScope) => {
    scopes.push(scope);
    return true;
  };
  return { store: new CentralCommands(db), guard, scopes, queries };
}

for (const field of ["hostId", "session"] as const) {
  for (const [label, value] of [
    ["missing", undefined],
    ["null", null],
    ["non-string", 42],
    ["empty", ""],
    ["blank", " \t\n"],
    ["too long", "x".repeat(257)],
    ["malformed UTF-16", "\ud800"],
  ] as const) {
    test(`listScoped rejects ${label} ${field} before guard and query`, async () => {
      const { store, guard, scopes, queries } = fixture();
      const scope = { hostId: "host-a", session: "session-a", [field]: value } as unknown as SupervisorCommandScope;
      const error = await store.listScoped(undefined, scope, guard).then(() => null, (reason: unknown) => reason);
      expect({ rejected: error instanceof Error, scopes, queries }).toEqual({ rejected: true, scopes: [], queries: [] });
    });
  }
}

test("listScoped passes a valid scope to its guard and query", async () => {
  const { store, guard, scopes, queries } = fixture();
  const scope = { hostId: "host-a", session: "session-a" };
  expect(await store.listScoped("queued", scope, guard, { limit: 2 })).toEqual({ commands: [], nextCursor: null });
  expect(scopes).toEqual([scope]);
  expect(queries).toEqual([["host-a", "host-a", "session-a", "session-a", "queued", "queued", null, null, null, 3]]);
});
