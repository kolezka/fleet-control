import type { SQL } from "bun";
import { CommandError } from "../commands.ts";
import type { Principal } from "./auth.ts";
import type { CooperativeTransactionRunner } from "./incarnations.ts";

export type ReconciliationDisposition = "unknown" | "completed" | "failed" | "not-executed";
export type Reconciliation = { commandId: string; requestId: string; actor: string; disposition: ReconciliationDisposition; evidence: string; expectedSequence: string | null; sequence: string; supersedesSequence: string | null; at: string };

const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const validSequence = (value: unknown): value is string | null => value === null || (typeof value === "string" && /^[1-9][0-9]*$/.test(value));

// Assertions are independent evidence, not authoritative lifecycle or execution state.
export class CooperativeReconciliation {
  constructor(private db: SQL, private now: () => Date = () => new Date(), private runner?: CooperativeTransactionRunner) {}

  async initialize(): Promise<void> {
    await this.db`CREATE TABLE IF NOT EXISTS central_cooperative_reconciliations (
      request_id TEXT PRIMARY KEY, command_id TEXT NOT NULL REFERENCES central_cooperative_claims(command_id),
      actor TEXT NOT NULL, disposition TEXT NOT NULL, evidence TEXT NOT NULL,
      expected_sequence TEXT, sequence NUMERIC(1000, 0) NOT NULL CHECK (sequence > 0),
      supersedes_sequence NUMERIC(1000, 0), at TEXT NOT NULL,
      UNIQUE (command_id, sequence)
    )`;
    await this.db`CREATE OR REPLACE FUNCTION central_block_reconciliation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'reconciliation is immutable'; END $$`;
    await this.db.begin(async (tx) => {
      await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      await tx`DROP TRIGGER IF EXISTS central_block_reconciliation_mutation ON central_cooperative_reconciliations`;
      await tx`CREATE TRIGGER central_block_reconciliation_mutation BEFORE UPDATE OR DELETE ON central_cooperative_reconciliations FOR EACH ROW EXECUTE FUNCTION central_block_reconciliation_mutation()`;
    });
  }

  async reconcile(principal: Principal, commandId: string, requestId: string, disposition: ReconciliationDisposition, evidence: string, expectedSequence: string | null, expectedAssertionSequence: string | null): Promise<Reconciliation> {
    if (!principal || principal.role !== "operator" || !validId(principal.name)) throw new Error("access denied");
    if (!validId(commandId) || !validId(requestId) || !["unknown", "completed", "failed", "not-executed"].includes(disposition) || typeof evidence !== "string" || evidence.length > 65536 || evidence.includes("\0") || !validSequence(expectedSequence) || !validSequence(expectedAssertionSequence)) throw new CommandError("invalid", "invalid reconciliation request");
    return (this.runner ?? ((operation) => this.db.begin(operation)))(async (tx) => {
      await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      const [existing] = await tx<Reconciliation[]>`SELECT command_id AS "commandId", request_id AS "requestId", actor, disposition, evidence, expected_sequence AS "expectedSequence", sequence::text AS sequence, supersedes_sequence::text AS "supersedesSequence", at FROM central_cooperative_reconciliations WHERE request_id = ${requestId}`;
      if (existing) {
        if (existing.commandId !== commandId || existing.actor !== principal.name || existing.disposition !== disposition || existing.evidence !== evidence || existing.expectedSequence !== expectedSequence || existing.supersedesSequence !== expectedAssertionSequence) throw new CommandError("conflict", "reconciliation request ID was used for a different intent");
        return existing;
      }
      const [claim] = await tx`SELECT command_id FROM central_cooperative_claims WHERE command_id = ${commandId}`;
      if (!claim) throw new Error("access denied");
      const [latest] = await tx<{ seq: string }[]>`SELECT seq::text AS seq FROM central_cooperative_lifecycle_events WHERE command_id = ${commandId} ORDER BY seq DESC LIMIT 1`;
      if ((latest?.seq ?? null) !== expectedSequence) throw new CommandError("conflict", "stale lifecycle sequence");
      const [latestAssertion] = await tx<{ sequence: string }[]>`SELECT sequence::text AS sequence FROM central_cooperative_reconciliations WHERE command_id = ${commandId} ORDER BY sequence DESC LIMIT 1`;
      if ((latestAssertion?.sequence ?? null) !== expectedAssertionSequence) throw new CommandError("conflict", "stale assertion sequence");
      const sequence = (BigInt(expectedAssertionSequence ?? "0") + 1n).toString();
      const at = this.now().toISOString();
      await tx`INSERT INTO central_cooperative_reconciliations (command_id, request_id, actor, disposition, evidence, expected_sequence, sequence, supersedes_sequence, at) VALUES (${commandId}, ${requestId}, ${principal.name}, ${disposition}, ${evidence}, ${expectedSequence}, ${sequence}::numeric, ${expectedAssertionSequence}::numeric, ${at})`;
      return { commandId, requestId, actor: principal.name, disposition, evidence, expectedSequence, sequence, supersedesSequence: expectedAssertionSequence, at };
    });
  }
}
