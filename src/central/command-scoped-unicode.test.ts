import { expect, test } from "bun:test";
import type { SQL, TransactionSQL } from "bun";
import { CentralCommands, type SupervisorCommandScope } from "./commands.ts";

const roundtrip = (value: string) => Buffer.from(value, "utf8").toString("utf8");
const replacement = "�";
const malformed = String.fromCharCode(0xd800);
const row = { id: replacement, hostId: replacement, target: replacement, status: "queued", idempotencyKey: "key", actor: "operator", text: "text", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" };

type Method = "get" | "transition" | "events";
function fixture() {
  const queries: { sql: string; values: unknown[] }[] = [];
  const scopes: SupervisorCommandScope[] = [];
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?");
    queries.push({ sql, values });
    if (sql.includes("FROM central_command_event_lock")) return [{ id: 1 }];
    if (sql.includes("FROM central_commands WHERE")) {
      return values.slice(0, 3).every((value) => typeof value === "string" && roundtrip(value) === replacement) ? [row] : [];
    }
    return [];
  }) as unknown as TransactionSQL;
  const db = { begin: async (fn: (tx: TransactionSQL) => Promise<unknown>) => fn(tx) } as unknown as SQL;
  const store = new CentralCommands(db);
  const guard = async (_tx: TransactionSQL, scope: SupervisorCommandScope) => { scopes.push(scope); return true; };
  const invoke = (method: Method, id: string, scope: SupervisorCommandScope) => method === "get"
    ? store.getScoped(id, scope, guard)
    : method === "transition"
      ? store.transitionScoped(id, "accepted", "supervisor", "accept", scope, guard)
      : store.eventsScoped(id, scope, guard);
  return { invoke, scopes, queries };
}

test("Bun UTF-8 replaces an isolated surrogate and valid replacement matches the fixture", async () => {
  expect(malformed.isWellFormed()).toBe(false);
  expect(roundtrip(malformed)).toBe(replacement);
  expect(roundtrip(replacement)).toBe(replacement);
  for (const method of ["get", "transition", "events"] as const) {
    const { invoke, queries } = fixture();
    await invoke(method, replacement, { hostId: replacement, session: replacement });
    expect(queries.some(({ sql }) => sql.includes("FROM central_commands WHERE"))).toBe(true);
  }
});

for (const method of ["get", "transition", "events"] as const) {
  for (const field of ["hostId", "session"] as const) {
    test(`${method}Scoped rejects NUL in ${field} before guard and SQL`, async () => {
      const { invoke, scopes, queries } = fixture();
      const scope = { hostId: field === "hostId" ? "host\0id" : replacement, session: field === "session" ? "session\0id" : replacement };
      const result = await invoke(method, replacement, scope).then(() => "resolved", () => "rejected");
      expect({ result, scopes, queries }).toEqual({ result: "rejected", scopes: [], queries: [] });
    });
  }
  for (const field of ["id", "hostId", "session"] as const) {
    test(`${method}Scoped rejects malformed UTF-16 in ${field} before guard and SQL`, async () => {
      const { invoke, scopes, queries } = fixture();
      const id = field === "id" ? malformed : replacement;
      const scope = { hostId: field === "hostId" ? malformed : replacement, session: field === "session" ? malformed : replacement };
      const result = await invoke(method, id, scope).then(() => "resolved", () => "rejected");
      expect({ result, scopes, queries }).toEqual({ result: "rejected", scopes: [], queries: [] });
    });
  }
}
