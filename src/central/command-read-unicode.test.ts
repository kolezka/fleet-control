import { expect, test } from "bun:test";
import type { SQL, TransactionSQL } from "bun";
import { CentralCommands } from "./data/commands.ts";
import type { CooperativeTransactionRunner } from "./data/incarnations.ts";

const replacement = "id-�";
const malformedIds = [0xd800, 0xdc00].map((unit) => `id-${String.fromCharCode(unit)}`);
const encode = (value: string) => Buffer.from(value, "utf8").toString("utf8");

type Method = "get" | "getBounded" | "events";

function fixture(method: Method, useRunner: boolean) {
  const queries: { sql: string; values: unknown[] }[] = [];
  let runnerCalls = 0;
  const query = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?");
    queries.push({ sql, values });
    if (method === "events") return [{ commandId: values.length === 1 ? "global" : encode(values[0] as string) }];
    const command = { id: encode(values[0] as string) };
    return method === "getBounded" ? [{ command }] : [command];
  }) as unknown as SQL & TransactionSQL;
  const runner: CooperativeTransactionRunner = (operation) => {
    runnerCalls++;
    return operation(query);
  };
  const store = new CentralCommands(query, undefined, useRunner ? runner : undefined);
  return { store, queries, runnerCalls: () => runnerCalls };
}

// This fake uses Buffer's UTF-8 replacement behavior. It is not a PostgreSQL test.
test("fake encoding distinguishes valid replacement input from malformed UTF-16", () => {
  expect(replacement.isWellFormed()).toBe(true);
  for (const id of malformedIds) {
    expect(id.isWellFormed()).toBe(false);
    expect(encode(id)).toBe(replacement);
  }
});

for (const method of ["get", "getBounded", "events"] as const) {
  for (const useRunner of [false, true]) {
    const route = useRunner ? "configured runner" : "direct";
    for (const id of malformedIds) {
      test(`${method} rejects isolated ${id.charCodeAt(3).toString(16)} before query (${route})`, async () => {
        const { store, queries, runnerCalls } = fixture(method, useRunner);
        await expect(store[method](id)).rejects.toThrow("invalid command ID");
        expect(queries).toEqual([]);
        expect(runnerCalls()).toBe(0);
      });
    }
    for (const id of [replacement, "id-ascii"]) {
      test(`${method} passes valid ${id} to fake query (${route})`, async () => {
        const { store, queries, runnerCalls } = fixture(method, useRunner);
        const result: unknown = await store[method](id);
        expect(result).toEqual(method === "events" ? [{ commandId: id }] : { id });
        expect(queries).toHaveLength(1);
        expect(queries[0]?.values[0]).toBe(id);
        expect(runnerCalls()).toBe(useRunner ? 1 : 0);
      });
    }
  }
}

for (const useRunner of [false, true]) {
  test(`events(undefined) remains global (${useRunner ? "configured runner" : "direct"})`, async () => {
    const { store, queries } = fixture("events", useRunner);
    const result: unknown = await store.events(undefined);
    expect(result).toEqual([{ commandId: "global" }]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.values).toEqual(["0"]);
    expect(queries[0]?.sql).not.toContain("WHERE command_id =");
  });
}
