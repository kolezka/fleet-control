import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { CommandError } from "../data/commands.ts";
import { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";
import { CooperativeReconciliation } from "./data/cooperative-reconciliation.ts";
import type { SupervisorIncarnations } from "./data/incarnations.ts";

const supervisor = { role: "supervisor", principalId: "principal", name: "supervisor", hostId: "host", session: "session" } as const;
const operator = { role: "operator", name: "operator" } as const;
const credential = { incarnationId: "incarnation", token: "token" };

for (const field of ["lifecycle detail", "reconciliation evidence"] as const) {
  function invoke(value: string) {
    const sentinel = new Error("transaction runner reached");
    let calls = 0;
    const runner = async () => { calls++; throw sentinel; };
    const promise = field === "lifecycle detail"
      ? new CooperativeLifecycle(null as unknown as SQL, null as unknown as SupervisorIncarnations, undefined, runner)
        .report(supervisor, credential, "command", "request", "accepted", value)
      : new CooperativeReconciliation(null as unknown as SQL, undefined, runner)
        .reconcile(operator, "command", "request", "unknown", value, null, null);
    return { promise, sentinel, calls: () => calls };
  }

  for (const value of ["\0", "\0text", "text\0more", "text\0"]) {
    test(`rejects NUL in ${field} before starting a transaction: ${JSON.stringify(value)}`, async () => {
      const result = invoke(value);
      const error = await result.promise.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).kind).toBe("invalid");
      expect(result.calls()).toBe(0);
    });
  }

  for (const value of ["", "ordinary text", "line one\nline two 😀", "x".repeat(65536)]) {
    test(`valid ${field} reaches the transaction runner (length ${value.length})`, async () => {
      const result = invoke(value);
      await expect(result.promise).rejects.toBe(result.sentinel);
      expect(result.calls()).toBe(1);
    });
  }
}
