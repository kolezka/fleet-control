import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CooperativeClaims } from "./data/cooperative-claims.ts";
import { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";
import type { SupervisorIncarnations } from "./data/incarnations.ts";

const principal = { role: "supervisor", principalId: "principal", name: "supervisor", hostId: "host", session: "session" } as const;
const credential = { incarnationId: "incarnation", token: "token" };
const at = "2026-01-01T00:00:00.000Z";
const command = { id: "command", idempotencyKey: "key", hostId: "host", target: "session", actor: "actor", text: "work", status: "queued", createdAt: at, updatedAt: at };

// Models commit and rollback only, not PostgreSQL locking or search_path resolution.
function fixture(exists: boolean) {
  const calls: string[] = [];
  let committed = { guard: 0, setup: 0, trigger: "original", command: "queued", claims: 0, events: 0, lifecycle: 0 };
  const begin = async <T>(operation: (tx: TransactionSQL) => Promise<T>): Promise<T> => {
    const staged = structuredClone(committed);
    const raw = (parts: TemplateStringsArray | string, ...values: unknown[]): any => {
      if (typeof parts === "string") {
        if (parts !== 'test"schema') throw new Error("Unexpected identifier: " + parts);
        return '"test""schema"';
      }
      const query = parts.reduce((text, part, i) => text + part + (i < values.length ? (typeof values[i] === "string" && values[i] === '"test""schema"' ? values[i] : "?") : ""), "").replace(/\s+/g, " ").trim();
      calls.push(query);
      if (query === "SELECT current_schema() AS schema") return [{ schema: 'test"schema' }];
      if (query.startsWith('CREATE TABLE IF NOT EXISTS "test""schema".central_cooperative_claims ')) { staged.setup++; return []; }
      if (query === 'SELECT id FROM "test""schema".central_command_event_lock WHERE id = 1 FOR UPDATE' || query === "SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE") return exists ? [{ id: 1 }] : [];
      if (query === 'DROP TRIGGER IF EXISTS central_block_cooperative_claim_mutation ON "test""schema".central_commands') { staged.trigger = "dropped"; return []; }
      if (query === 'CREATE TRIGGER central_block_cooperative_claim_mutation BEFORE UPDATE OR DELETE ON "test""schema".central_commands FOR EACH ROW EXECUTE FUNCTION "test""schema".central_block_cooperative_claim_mutation()') { staged.trigger = "created"; return []; }
      if (query === "UPDATE fake_guard SET writes = writes + 1") { staged.guard++; return []; }
      if (query.startsWith('SELECT command_id AS "commandId" FROM central_cooperative_claims ')) return [];
      if (query.startsWith('SELECT id, idempotency_key') && query.includes("FROM central_commands AS command")) return [command];
      if (query.startsWith("UPDATE central_commands SET status = 'claimed'")) { staged.command = "claimed"; return [{ ...command, status: "claimed", updatedAt: at }]; }
      if (query.startsWith("INSERT INTO central_cooperative_claims ")) { staged.claims++; return []; }
      if (query.startsWith("INSERT INTO central_command_events ")) { staged.events++; return []; }
      if (query.startsWith("SELECT command_id FROM central_cooperative_claims ")) return [{ command_id: "command" }];
      if (query.startsWith('SELECT command_id AS "commandId", request_id AS "requestId"')) return [];
      if (query === "SELECT status FROM central_cooperative_lifecycle_events WHERE command_id = ? ORDER BY seq DESC LIMIT 1") return [];
      if (query.startsWith("INSERT INTO central_cooperative_lifecycle_events ")) { staged.lifecycle++; return []; }
      throw new Error("Unexpected SQL: " + query);
    };
    raw.unsafe = async (query: string) => {
      if (!query.startsWith('CREATE OR REPLACE FUNCTION "test""schema".central_block_cooperative_claim_mutation()')) throw new Error("Unexpected unsafe SQL: " + query);
      calls.push("function"); staged.setup++; return [];
    };
    const result = await operation(raw as TransactionSQL);
    committed = staged;
    return result;
  };
  const db = { begin } as unknown as SQL;
  const incarnations = { async lockForClaim() { calls.push("incarnation lock"); return true; } } as unknown as SupervisorIncarnations;
  const runner = <T>(operation: (tx: TransactionSQL) => Promise<T>) => begin(async (tx) => { await tx`UPDATE fake_guard SET writes = writes + 1`; return operation(tx); });
  return { calls, snapshot: () => structuredClone(committed), claims: new CooperativeClaims(db, incarnations, () => new Date(at), runner), lifecycle: new CooperativeLifecycle(db, incarnations, () => new Date(at), runner) };
}

for (const exists of [false, true]) {
  test("initialize " + (exists ? "locks before trigger replacement" : "rolls back without singleton"), async () => {
    const f = fixture(exists);
    const operation = f.claims.initialize();
    if (exists) await operation;
    else await expect(operation).rejects.toThrow("central command event lock row missing");
    expect(f.calls).toEqual([
      "SELECT current_schema() AS schema",
      expect.stringContaining('CREATE TABLE IF NOT EXISTS "test""schema".central_cooperative_claims'),
      "function",
      'SELECT id FROM "test""schema".central_command_event_lock WHERE id = 1 FOR UPDATE',
      ...(exists ? ['DROP TRIGGER IF EXISTS central_block_cooperative_claim_mutation ON "test""schema".central_commands', 'CREATE TRIGGER central_block_cooperative_claim_mutation BEFORE UPDATE OR DELETE ON "test""schema".central_commands FOR EACH ROW EXECUTE FUNCTION "test""schema".central_block_cooperative_claim_mutation()'] : []),
    ]);
    expect(f.snapshot().trigger).toBe(exists ? "created" : "original");
    expect(f.snapshot().setup).toBe(exists ? 2 : 0);
  });
  test("claim " + (exists ? "locks before command and event writes" : "rolls back without singleton"), async () => {
    const f = fixture(exists);
    const operation = f.claims.claim(principal, credential, "request");
    if (exists) expect(await operation).toEqual({ ...command, status: "claimed" });
    else await expect(operation).rejects.toThrow("central command event lock row missing");
    expect(f.calls.slice(0, 3)).toEqual(["UPDATE fake_guard SET writes = writes + 1", "incarnation lock", "SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE"]);
    expect(f.calls.length).toBe(exists ? 8 : 3);
    if (exists) expect(f.calls.slice(3).map((q) => q.split(" ").slice(0, 3).join(" "))).toEqual(["SELECT command_id AS", "SELECT id, idempotency_key", "UPDATE central_commands SET", "INSERT INTO central_cooperative_claims", "INSERT INTO central_command_events"]);
    expect(f.snapshot()).toEqual({ guard: exists ? 1 : 0, setup: 0, trigger: "original", command: exists ? "claimed" : "queued", claims: exists ? 1 : 0, events: exists ? 1 : 0, lifecycle: 0 });
  });
  test("report " + (exists ? "locks before lifecycle insert" : "rolls back without singleton"), async () => {
    const f = fixture(exists);
    const operation = f.lifecycle.report(principal, credential, "command", "request", "accepted", "detail");
    if (exists) expect(await operation).toEqual({ commandId: "command", requestId: "request", status: "accepted", detail: "detail", at });
    else await expect(operation).rejects.toThrow("central command event lock row missing");
    expect(f.calls.slice(0, 3)).toEqual(["UPDATE fake_guard SET writes = writes + 1", "incarnation lock", "SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE"]);
    expect(f.calls.length).toBe(exists ? 7 : 3);
    if (exists) expect(f.calls[6]).toStartWith("INSERT INTO central_cooperative_lifecycle_events ");
    expect(f.snapshot()).toEqual({ guard: exists ? 1 : 0, setup: 0, trigger: "original", command: "queued", claims: 0, events: 0, lifecycle: exists ? 1 : 0 });
  });
}
