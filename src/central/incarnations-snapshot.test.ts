import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SupervisorIncarnations, type CooperativeTransactionRunner } from "./incarnations.ts";

function deferredTransaction() {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: unknown[][] = [];
  const tx = (async (_parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    if (calls.length === 1) {
      entered();
      await gate;
    }
    return [{}];
  }) as unknown as TransactionSQL;
  return { tx, calls, waiting, release };
}

const originalIdentity = () => ({ principalId: "principal-a", name: "supervisor-a", hostId: "host-a", session: "session-a" });
const changedIdentity = { principalId: "principal-b", name: "supervisor-b", hostId: "host-b", session: "session-b" };

test("activation uses the original identity throughout its transaction", async () => {
  const fake = deferredTransaction();
  const runner: CooperativeTransactionRunner = (operation) => operation(fake.tx);
  const incarnations = new SupervisorIncarnations({} as SQL, runner);
  const identity = originalIdentity();
  const pending = incarnations.activate(identity);
  await fake.waiting;
  Object.assign(identity, changedIdentity);
  fake.release();
  const credential = await pending;

  expect(fake.calls).toEqual([
    ["host-a", "session-a"],
    ["host-a", "session-a"],
    ["principal-a", "supervisor-a", "host-a", "session-a"],
    ["host-a", "session-a"],
    [credential.incarnationId, "principal-a", createHash("sha256").update(credential.token).digest("hex")],
  ]);
});

test("claim lock uses the original identity and credential after awaiting the slot", async () => {
  const fake = deferredTransaction();
  const incarnations = new SupervisorIncarnations({} as SQL);
  const identity = originalIdentity();
  const credential = { incarnationId: "12345678-1234-4123-8123-123456789abc", token: "a".repeat(43) };
  const originalCredential = { ...credential };
  const pending = incarnations.lockForClaim(fake.tx, identity, credential);
  await fake.waiting;
  Object.assign(identity, changedIdentity);
  Object.assign(credential, { incarnationId: "abcdefab-1234-4123-8123-123456789abc", token: "b".repeat(43) });
  fake.release();
  expect(await pending).toBe(true);

  expect(fake.calls).toEqual([
    ["host-a", "session-a"],
    ["principal-a", "supervisor-a", "host-a", "session-a"],
    [originalCredential.incarnationId, "principal-a", createHash("sha256").update(originalCredential.token).digest("hex")],
  ]);
});
