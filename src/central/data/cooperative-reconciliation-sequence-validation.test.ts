import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { CommandError } from "../../domain/commands.ts";
import { CooperativeReconciliation } from "./cooperative-reconciliation.ts";

const principal = { role: "operator", name: "operator" } as const;
const runnerSentinel = new Error("runner reached");

function reconcile(expectedSequence: string | null, expectedAssertionSequence: string | null) {
  const store = new CooperativeReconciliation(null as unknown as SQL, undefined, async () => { throw runnerSentinel; });
  return store.reconcile(principal, "command", "request", "unknown", "evidence", expectedSequence, expectedAssertionSequence);
}

const noncanonical = ["", "0", "00", "01", "-1", "+1", " 1", "1 ", "1.0", "1e2", "١", "1\n"];

for (const field of ["lifecycle", "assertion"] as const) {
  for (const value of noncanonical) {
    test(`rejects noncanonical ${field} sequence ${JSON.stringify(value)}`, async () => {
      const error = await reconcile(field === "lifecycle" ? value : null, field === "assertion" ? value : null).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).kind).toBe("invalid");
    });
  }
}

for (const value of ["9223372036854775808", "9999999999999999999", "1".repeat(1001), "9".repeat(10000)]) {
  test(`rejects lifecycle sequence beyond signed bigint (${value.length} digits)`, async () => {
    const error = await reconcile(value, null).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).kind).toBe("invalid");
  });
}

for (const value of ["1".repeat(1001), "9".repeat(10000)]) {
  test(`rejects assertion sequence beyond 1000 digits (${value.length} digits)`, async () => {
    const error = await reconcile(null, value).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).kind).toBe("invalid");
  });
}

for (const [lifecycle, assertion] of [
  [null, null],
  ["1", "1"],
  ["9223372036854775806", "9".repeat(999)],
  ["9223372036854775807", "1" + "0".repeat(999)],
  ["9223372036854775807", "9".repeat(1000)],
] as const) {
  test(`valid sequence boundaries reach the runner (${lifecycle?.length ?? 0}, ${assertion?.length ?? 0} digits)`, async () => {
    await expect(reconcile(lifecycle, assertion)).rejects.toBe(runnerSentinel);
  });
}
