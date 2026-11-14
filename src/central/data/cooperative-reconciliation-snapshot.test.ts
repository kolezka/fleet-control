import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import type { CooperativeTransactionRunner } from "./incarnations.ts";
import { CooperativeReconciliation } from "./cooperative-reconciliation.ts";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

const principal = () => ({ role: "operator" as const, name: "operator-a" });
const row = (sequence: string) => ({ present: true, oversized: false, commandId: "command", requestId: "request-" + sequence, actor: "operator-a", disposition: "completed" as const, evidence: "evidence", expectedSequence: null, sequence, supersedesSequence: null, at: "2026-01-01T00:00:00.000Z" });

function delayedRunner(tx: TransactionSQL) {
  const entered = gate();
  const resume = gate();
  const runner: CooperativeTransactionRunner = async (operation) => {
    entered.release();
    await resume.wait;
    return operation(tx);
  };
  return { runner, entered: entered.wait, release: resume.release };
}

test("bounded list uses the validated limit after a delayed runner", async () => {
  const calls: unknown[][] = [];
  const tx = (async (_parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return [row("1"), row("2"), row("3"), row("4"), row("5")];
  }) as unknown as TransactionSQL;
  const delayed = delayedRunner(tx);
  const store = new CooperativeReconciliation({} as SQL, undefined, delayed.runner);
  const options = { limit: 4, cursor: "0" };
  const pending = store.listBounded(principal(), "command", options);
  await delayed.entered;
  options.limit = 100;
  delayed.release();
  const result = await pending;
  expect(calls[0]).toEqual(["0", 5, "command"]);
  expect(result?.assertions.map((item) => item.sequence)).toEqual(["1", "2", "3", "4"]);
  expect(result?.nextCursor).toBe("4");
});

test("bounded list uses the same limit when SQL is pending and pagination is built", async () => {
  const entered = gate();
  const resume = gate();
  const calls: unknown[][] = [];
  const tx = (async (_parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    entered.release();
    await resume.wait;
    return [row("1"), row("2"), row("3")];
  }) as unknown as TransactionSQL;
  const store = new CooperativeReconciliation({} as SQL, undefined, (operation) => operation(tx));
  const options = { limit: 2 };
  const pending = store.listBounded(principal(), "command", options);
  await entered.wait;
  options.limit = 4;
  resume.release();
  const result = await pending;
  expect(calls[0]).toEqual(["0", 3, "command"]);
  expect(result?.assertions.map((item) => item.sequence)).toEqual(["1", "2"]);
  expect(result?.nextCursor).toBe("2");
});

test("reconcile writes the validated actor after a delayed runner", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?");
    calls.push({ sql, values });
    if (sql.includes("FROM central_command_event_lock")) return [{ id: 1 }];
    if (sql.includes("FROM central_cooperative_claims")) return [{ command_id: "command" }];
    return [];
  }) as unknown as TransactionSQL;
  const delayed = delayedRunner(tx);
  const store = new CooperativeReconciliation({} as SQL, () => new Date("2026-01-01T00:00:00.000Z"), delayed.runner);
  const actor = principal();
  const pending = store.reconcile(actor, "command", "request", "completed", "evidence", null, null);
  await delayed.entered;
  actor.name = "operator-b";
  delayed.release();
  const result = await pending;
  expect(calls.find((call) => call.sql.includes("INSERT INTO"))?.values[2]).toBe("operator-a");
  expect(result.actor).toBe("operator-a");
});

test("reconcile compares replay against the validated actor after a delayed runner", async () => {
  const existing = { ...row("1"), requestId: "request" };
  const tx = (async (parts: TemplateStringsArray) => {
    if (parts.join("?").includes("FROM central_command_event_lock")) return [{ id: 1 }];
    if (parts.join("?").includes("WHERE request_id")) return [existing];
    return [];
  }) as unknown as TransactionSQL;
  const delayed = delayedRunner(tx);
  const store = new CooperativeReconciliation({} as SQL, undefined, delayed.runner);
  const actor = principal();
  const pending = store.reconcile(actor, "command", "request", "completed", "evidence", null, null);
  await delayed.entered;
  actor.name = "operator-b";
  delayed.release();
  await expect(pending).resolves.toEqual(existing);
});
