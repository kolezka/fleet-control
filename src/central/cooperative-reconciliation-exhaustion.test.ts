import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CommandError } from "../commands.ts";
import { CooperativeReconciliation, type Reconciliation } from "./cooperative-reconciliation.ts";

const principal = { role: "operator", name: "operator" } as const;
const maximum = "9".repeat(1000);
const maximumMinusOne = "9".repeat(999) + "8";
const at = "2026-01-01T00:00:00.000Z";

function fixture(latest: string, existing?: Reconciliation) {
  const inserts: unknown[][] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("central_command_event_lock")) return [{ id: 1 }];
    if (query.includes("WHERE request_id =")) return existing ? [existing] : [];
    if (query.includes("FROM central_cooperative_claims")) return [{ command_id: "command" }];
    if (query.includes("FROM central_cooperative_lifecycle_events")) return [];
    if (query.includes("ORDER BY sequence DESC")) return [{ sequence: latest }];
    if (query.includes("INSERT INTO central_cooperative_reconciliations")) {
      inserts.push(values);
      if (String(values[6]).length > 1000) throw new Error("numeric field overflow");
      return [];
    }
    throw new Error("unexpected query: " + query);
  }) as unknown as TransactionSQL;
  const store = new CooperativeReconciliation(null as unknown as SQL, () => new Date(at), async (operation) => operation(tx));
  return { store, inserts };
}

function reconcile(store: CooperativeReconciliation, predecessor: string) {
  return store.reconcile(principal, "command", "request", "unknown", "evidence", null, predecessor);
}

test("exact replay returns the maximum assertion after it was written", async () => {
  const existing: Reconciliation = { commandId: "command", requestId: "request", actor: "operator", disposition: "unknown", evidence: "evidence", expectedSequence: null, sequence: maximum, supersedesSequence: maximumMinusOne, at };
  const { store, inserts } = fixture(maximum, existing);
  expect(await reconcile(store, maximumMinusOne)).toEqual(existing);
  const error = await reconcile(store, maximum).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CommandError);
  expect((error as CommandError).message).toContain("different intent");
  expect(inserts).toHaveLength(0);
});

test("exhausted assertion sequence fails explicitly before insert", async () => {
  const { store, inserts } = fixture(maximum);
  const error = await reconcile(store, maximum).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CommandError);
  expect((error as CommandError).kind).toBe("conflict");
  expect((error as CommandError).message).toBe("assertion sequence exhausted");
  expect(inserts).toHaveLength(0);
});

test("maximum minus one inserts the maximum assertion sequence", async () => {
  const { store, inserts } = fixture(maximumMinusOne);
  const result = await reconcile(store, maximumMinusOne);
  expect(result.sequence).toBe(maximum);
  expect(result.supersedesSequence).toBe(maximumMinusOne);
  expect(inserts).toHaveLength(1);
  expect(inserts[0]![6]).toBe(maximum);
  expect(inserts[0]![7]).toBe(maximumMinusOne);
});
