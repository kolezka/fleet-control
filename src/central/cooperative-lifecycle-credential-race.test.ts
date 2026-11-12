import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import type { CooperativeTransactionRunner, SupervisorIncarnations } from "./incarnations.ts";

test("lifecycle report uses the authenticated incarnation after the lock awaits", async () => {
  const credential = { incarnationId: "original-incarnation", token: "original-token" };
  const principal = { role: "supervisor" as const, principalId: "principal", name: "supervisor", hostId: "host", session: "session" };
  let entered!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  let authenticatedId = "";
  let claimId = "";
  let insertedId = "";
  const incarnations = {
    async lockForClaim(_tx: TransactionSQL, _identity: unknown, supplied: typeof credential) {
      authenticatedId = supplied.incarnationId;
      entered();
      await resume;
      return true;
    },
  } as unknown as SupervisorIncarnations;
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("FROM central_cooperative_claims")) {
      claimId = values[1] as string;
      return [{ command_id: values[0] }];
    }
    if (query.includes("INSERT INTO central_cooperative_lifecycle_events")) insertedId = values[1] as string;
    return [];
  }) as unknown as TransactionSQL;
  const runner: CooperativeTransactionRunner = (operation) => operation(tx);
  const lifecycle = new CooperativeLifecycle({} as SQL, incarnations, () => new Date("2026-01-01T00:00:00.000Z"), runner);

  const pending = lifecycle.report(principal, credential, "command", "request", "accepted", "");
  await locked;
  credential.incarnationId = "other-incarnation";
  credential.token = "other-token";
  release();
  await pending;

  expect(authenticatedId).toBe("original-incarnation");
  expect(claimId).toBe(authenticatedId);
  expect(insertedId).toBe(authenticatedId);
});
