import { expect, test } from "bun:test";
import type { TransactionSQL } from "bun";
import { identityFence } from "./identity-fence.ts";

const identity = { principalId: "p-1", name: "sup", hostId: "host", session: "session" };
const tx = { marker: "tx" } as unknown as TransactionSQL;

// No default for the answer: an undefined answer is one of the cases.
function registry(answer: unknown) {
  const seen: unknown[][] = [];
  return { seen, lockActive: async (...args: unknown[]) => { seen.push(args); return answer as boolean; } };
}

test("both guards lock the identity in the transaction they are given", async () => {
  const active = registry(true);
  const fence = identityFence(active, identity);
  expect(fence.scope).toEqual({ hostId: "host", session: "session" });
  expect(await fence.commands(tx, fence.scope)).toBe(true);
  await fence.requests(tx);
  expect(active.seen).toEqual([[tx, identity], [tx, identity]]);
});

test.each([
  ["another host", { hostId: "other", session: "session" }],
  ["another session", { hostId: "host", session: "other" }],
  ["no scope", undefined],
])("the command guard refuses %s before it touches the registry", async (_name, scope) => {
  const active = registry(true);
  await expect(identityFence(active, identity).commands(tx, scope as never)).rejects.toThrow("access denied");
  expect(active.seen).toEqual([]);
});

test.each([["retired", false], ["a truthy non-boolean", "yes"], ["nothing", undefined]])("an identity the registry reports as %s is refused by both guards", async (_name, answer) => {
  const fence = identityFence(registry(answer), identity);
  await expect(fence.commands(tx, fence.scope)).rejects.toThrow("access denied");
  await expect(fence.requests(tx)).rejects.toThrow("access denied");
});

test("without a registry both guards refuse", async () => {
  const fence = identityFence(undefined, identity);
  await expect(fence.commands(tx, fence.scope)).rejects.toThrow("access denied");
  await expect(fence.requests(tx)).rejects.toThrow("access denied");
});

test("a registry failure is passed on, not turned into access", async () => {
  const fence = identityFence({ lockActive: async () => { throw new Error("database down"); } }, identity);
  await expect(fence.commands(tx, fence.scope)).rejects.toThrow("database down");
  await expect(fence.requests(tx)).rejects.toThrow("database down");
});

test("the fence keeps the identity it was built with", async () => {
  const active = registry(true);
  const mutable = { ...identity };
  const fence = identityFence(active, mutable);
  mutable.session = "other";
  (fence.scope as { session: string }).session = "other";
  await fence.commands(tx, { hostId: "host", session: "session" });
  expect(active.seen).toEqual([[tx, identity]]);
  await expect(fence.commands(tx, { hostId: "host", session: "other" })).rejects.toThrow("access denied");
});
