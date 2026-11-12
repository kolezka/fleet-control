import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import type { CooperativeTransactionRunner } from "./incarnations.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";

const original = () => ({ principalId: "principal", name: "name", hostId: "host", session: "session" });
const changed = { principalId: "other-principal", name: "other-name", hostId: "other-host", session: "other-session" };
const valuesOf = (identity: ReturnType<typeof original>) => [identity.principalId, identity.name, identity.hostId, identity.session];

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

for (const method of ["enroll", "matches", "retire"] as const) {
  test(`${method} uses the validated identity after a delayed runner`, async () => {
    const identity = original();
    const expected = original();
    const entered = gate();
    const resume = gate();
    const calls: unknown[][] = [];
    const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      if (parts.join("?").includes("SELECT name")) return [{ ...expected, retired: false }];
      return [{}];
    }) as unknown as TransactionSQL;
    const runner: CooperativeTransactionRunner = async (operation) => {
      entered.release();
      await resume.wait;
      return operation(tx);
    };
    const registry = new SupervisorIdentityRegistry({} as SQL, runner);
    const pending = registry[method](identity);
    await entered.wait;
    Object.assign(identity, changed);
    resume.release();
    const result = await Promise.allSettled([pending]);
    expect(calls[0]).toEqual(valuesOf(expected));
    if (method === "enroll") expect(calls[1]).toEqual([expected.principalId]);
    expect(result[0].status).toBe("fulfilled");
  });
}

test("enroll keeps the identity fixed between insert and select", async () => {
  const identity = original();
  const expected = original();
  const entered = gate();
  const resume = gate();
  const calls: unknown[][] = [];
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    if (parts.join("?").includes("INSERT INTO")) {
      entered.release();
      await resume.wait;
      return [];
    }
    return [{ ...expected, retired: false }];
  }) as unknown as TransactionSQL;
  const runner: CooperativeTransactionRunner = (operation) => operation(tx);
  const registry = new SupervisorIdentityRegistry({} as SQL, runner);
  const pending = registry.enroll(identity);
  await entered.wait;
  Object.assign(identity, changed);
  resume.release();
  const result = await Promise.allSettled([pending]);
  expect(calls).toEqual([valuesOf(expected), [expected.principalId]]);
  expect(result[0].status).toBe("fulfilled");
});

test("enroll compares the stored binding with the validated identity after select awaits", async () => {
  const identity = original();
  const expected = original();
  const entered = gate();
  const resume = gate();
  const tx = (async (parts: TemplateStringsArray) => {
    if (parts.join("?").includes("INSERT INTO")) return [];
    entered.release();
    await resume.wait;
    return [{ ...expected, retired: false }];
  }) as unknown as TransactionSQL;
  const runner: CooperativeTransactionRunner = (operation) => operation(tx);
  const registry = new SupervisorIdentityRegistry({} as SQL, runner);
  const pending = registry.enroll(identity);
  await entered.wait;
  Object.assign(identity, changed);
  resume.release();
  await expect(pending).resolves.toBeUndefined();
});
