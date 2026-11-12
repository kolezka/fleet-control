import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { SupervisorIdentityRegistry, type SupervisorIdentity } from "./identity-registry.ts";

const identity = (): SupervisorIdentity => ({ principalId: "principal", name: "name", hostId: "host", session: "session" });

test("locks the exact active identity in the caller transaction", async () => {
  const calls: { query: string; values: unknown[] }[] = [];
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: parts.join("?"), values });
    return [{}];
  }) as unknown as TransactionSQL;
  const registry = new SupervisorIdentityRegistry({} as SQL, async () => { throw new Error("unexpected runner"); });
  expect(await registry.lockActive(tx, identity())).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.query.replace(/\s+/g, " ")).toMatch(/SELECT principal_id FROM central_supervisor_identities_v2 WHERE principal_id = \? AND name = \? AND host_id = \? AND session = \? AND retired = FALSE FOR UPDATE/i);
  expect(calls[0]!.values).toEqual(["principal", "name", "host", "session"]);
});

test("missing or ambiguous rows fail closed and SQL errors propagate", async () => {
  const registry = new SupervisorIdentityRegistry({} as SQL);
  for (const rows of [[], [{}, {}]]) {
    const tx = (async () => rows) as unknown as TransactionSQL;
    expect(await registry.lockActive(tx, identity())).toBe(false);
  }
  const error = new Error("query failed");
  const tx = (async () => { throw error; }) as unknown as TransactionSQL;
  await expect(registry.lockActive(tx, identity())).rejects.toBe(error);
});

test("invalid identity is rejected without querying", async () => {
  const registry = new SupervisorIdentityRegistry({} as SQL);
  const tx = (() => { throw new Error("unexpected query"); }) as unknown as TransactionSQL;
  for (const field of ["principalId", "name", "hostId", "session"] as const) {
    for (const value of ["", " padded ", "bad\u0000value", "\ud800", "x".repeat(257), 42]) {
      const invalid = { ...identity(), [field]: value } as SupervisorIdentity;
      expect(await registry.lockActive(tx, invalid)).toBe(false);
    }
  }
  expect(await registry.lockActive(tx, null as unknown as SupervisorIdentity)).toBe(false);
});

test("validates and queries the same single-read identity snapshot", async () => {
  const reads: Record<string, number> = {};
  const input = Object.fromEntries(Object.entries(identity()).map(([key, value]) => [key, value]));
  const changing = new Proxy(input, { get(target, key: string) { reads[key] = (reads[key] ?? 0) + 1; return reads[key] === 1 ? target[key] : "changed"; } }) as SupervisorIdentity;
  let values: unknown[] = [];
  const tx = (async (_parts: TemplateStringsArray, ...parameters: unknown[]) => { values = parameters; return [{}]; }) as unknown as TransactionSQL;
  expect(await new SupervisorIdentityRegistry({} as SQL).lockActive(tx, changing)).toBe(true);
  expect(values).toEqual(["principal", "name", "host", "session"]);
  expect(Object.values(reads)).toEqual([1, 1, 1, 1]);
});

test("snapshots every field before awaiting the transaction query", async () => {
  const input = identity();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let captured: unknown[] = [];
  const tx = (async (_parts: TemplateStringsArray, ...values: unknown[]) => {
    await gate;
    captured = values;
    return [{}];
  }) as unknown as TransactionSQL;
  const registry = new SupervisorIdentityRegistry({} as SQL);
  const pending = registry.lockActive(tx, input);
  Object.assign(input, { principalId: "changed", name: "changed", hostId: "changed", session: "changed" });
  release();
  expect(await pending).toBe(true);
  expect(captured).toEqual(["principal", "name", "host", "session"]);
});
