import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CooperativeReconciliation } from "./cooperative-reconciliation.ts";

const principal = { role: "operator", name: "operator" } as const;
const existing = { commandId: "command", requestId: "request", actor: "operator", disposition: "unknown" as const, evidence: "evidence", expectedSequence: null, sequence: "1", supersedesSequence: null, at: "2026-01-01T00:00:00.000Z" };

// Models transaction commit and rollback, not PostgreSQL lock contention.
function fixture(exists: boolean, replay = false) {
  const calls: string[] = [];
  let committed = { trigger: "original", inserts: 0, guardWrites: 0 };
  const begin = async (operation: (tx: TransactionSQL) => Promise<any>) => {
    const staged = structuredClone(committed);
    const tx = (async (parts: TemplateStringsArray) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      if (query === "UPDATE fake_guard SET writes = writes + 1") { calls.push("guard"); staged.guardWrites++; return []; }
      if (query === "SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE") { calls.push("lock"); return exists ? [{ id: 1 }] : []; }
      if (query.startsWith("DROP TRIGGER")) { calls.push("drop trigger"); staged.trigger = "dropped"; return []; }
      if (query.startsWith("CREATE TRIGGER")) { calls.push("create trigger"); staged.trigger = "created"; return []; }
      if (query.includes("WHERE request_id =")) { calls.push("replay lookup"); return replay ? [existing] : []; }
      if (query.includes("FROM central_cooperative_claims")) { calls.push("claim lookup"); return [{ command_id: "command" }]; }
      if (query.includes("FROM central_cooperative_lifecycle_events")) { calls.push("lifecycle lookup"); return []; }
      if (query.includes("ORDER BY sequence DESC")) { calls.push("assertion lookup"); return []; }
      if (query.startsWith("INSERT INTO central_cooperative_reconciliations")) { calls.push("insert"); staged.inserts++; return []; }
      throw new Error("Unexpected SQL: " + query);
    }) as unknown as TransactionSQL;
    const result = await operation(tx);
    committed = staged;
    return result;
  };
  const db = Object.assign(async (parts: TemplateStringsArray) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("CREATE TABLE IF NOT EXISTS") || query.startsWith("CREATE OR REPLACE FUNCTION")) { calls.push("setup"); return []; }
    throw new Error("Unexpected setup SQL: " + query);
  }, { begin }) as unknown as SQL;
  const runner = async (operation: (tx: TransactionSQL) => Promise<any>) => begin(async (tx) => { await tx`UPDATE fake_guard SET writes = writes + 1`; return operation(tx); });
  return { store: new CooperativeReconciliation(db, () => new Date(existing.at), runner), calls, snapshot: () => structuredClone(committed) };
}

for (const exists of [false, true]) {
  test("initialize " + (exists ? "replaces trigger with lock" : "does not touch trigger without lock"), async () => {
    const f = fixture(exists);
    if (!exists) {
      await expect(f.store.initialize()).rejects.toThrow("central command event lock row missing");
      expect(f.calls).toEqual(["setup", "setup", "lock"]);
      expect(f.snapshot().trigger).toBe("original");
    } else {
      await f.store.initialize();
      expect(f.calls).toEqual(["setup", "setup", "lock", "drop trigger", "create trigger"]);
      expect(f.snapshot().trigger).toBe("created");
    }
  });
  for (const replay of [false, true]) {
    test("reconcile " + (replay ? "replay" : "new assertion") + (exists ? " with lock" : " fails without lock"), async () => {
      const f = fixture(exists, replay);
      const operation = f.store.reconcile(principal, "command", "request", "unknown", "evidence", null, null);
      if (!exists) {
        await expect(operation).rejects.toThrow("central command event lock row missing");
        expect(f.calls).toEqual(["guard", "lock"]);
        expect(f.snapshot()).toEqual({ trigger: "original", inserts: 0, guardWrites: 0 });
      } else {
        const result = await operation;
        expect(result).toEqual(existing);
        expect(f.calls).toEqual(replay ? ["guard", "lock", "replay lookup"] : ["guard", "lock", "replay lookup", "claim lookup", "lifecycle lookup", "assertion lookup", "insert"]);
        expect(f.snapshot()).toEqual({ trigger: "original", inserts: replay ? 0 : 1, guardWrites: 1 });
      }
    });
  }
}
