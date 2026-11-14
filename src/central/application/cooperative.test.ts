import { expect, test } from "bun:test";
import { cooperativeOperator } from "./cooperative.ts";
import type { Principal } from "../domain/identity.ts";

const operator: Principal = { name: "op", role: "operator" };
const others: Principal[] = [
  { name: "sup", role: "supervisor", principalId: "p-1", hostId: "host", session: "session" },
  { name: "agent", role: "host", hostId: "host" },
];

function stores() {
  const calls: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return name as never; };
  return {
    calls,
    deps: {
      inspection: { inspectBounded: record("inspectBounded") },
      reconciliation: { listBounded: record("listBounded") },
      settlement: { get: record("get"), settle: record("settle") },
    },
  };
}

test("an operator reaches each store with its own identity and the given arguments", async () => {
  const { calls, deps } = stores();
  const use = cooperativeOperator(deps, operator);
  expect(await use.inspect("c-1", { limit: 2, cursor: "7" })).toBe("inspectBounded" as never);
  expect(await use.assertions("c-1", { limit: 4 })).toBe("listBounded" as never);
  expect(await use.settlement("c-1")).toBe("get" as never);
  expect(await use.settle("c-1", { requestId: "r-1", disposition: "failed", evidence: "log", expectedSequence: "3" })).toBe("settle" as never);
  expect(calls).toEqual([
    ["inspectBounded", "c-1", { limit: 2, cursor: "7" }],
    ["listBounded", operator, "c-1", { limit: 4 }],
    ["get", operator, "c-1"],
    ["settle", operator, "c-1", "r-1", "failed", "log", "3"],
  ]);
});

test.each(others)("a $role is refused everywhere and no store is called", async (principal) => {
  const { calls, deps } = stores();
  const use = cooperativeOperator(deps, principal);
  await expect(use.inspect("c-1", { limit: 1 })).rejects.toThrow("access denied");
  await expect(use.assertions("c-1", { limit: 1 })).rejects.toThrow("access denied");
  await expect(use.settlement("c-1")).rejects.toThrow("access denied");
  await expect(use.settle("c-1", { requestId: "r-1", disposition: "unknown", evidence: "", expectedSequence: null })).rejects.toThrow("access denied");
  expect(calls).toEqual([]);
});

test("a missing principal and a store that was not provided are refused", async () => {
  const { calls, deps } = stores();
  await expect(cooperativeOperator(deps, undefined as never).inspect("c-1", { limit: 1 })).rejects.toThrow("access denied");
  const none = cooperativeOperator({}, operator);
  await expect(none.inspect("c-1", { limit: 1 })).rejects.toThrow("access denied");
  await expect(none.assertions("c-1", { limit: 1 })).rejects.toThrow("access denied");
  await expect(none.settlement("c-1")).rejects.toThrow("access denied");
  expect(calls).toEqual([]);
});

test("a store's own error reaches the caller unchanged", async () => {
  const failure = new Error("database down");
  const use = cooperativeOperator({ inspection: { inspectBounded: async () => { throw failure; } } }, operator);
  await expect(use.inspect("c-1", { limit: 1 })).rejects.toBe(failure);
});
