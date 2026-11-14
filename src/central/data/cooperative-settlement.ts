import type { SQL, TransactionSQL } from "bun";
import { CommandError } from "../../domain/commands.ts";
import type { Principal } from "../domain/identity.ts";
import type { CooperativeTransactionRunner } from "./incarnations.ts";
import { type SettlementDisposition, type Settlement, settlementDispositions } from "../domain/cooperative.ts";

const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
const validLifecycleSequence = (value: unknown): value is string | null => value === null || (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);

// Operator settlement of a claim nobody can report on any more (owner decision, PR #35 option A).
// One terminal record per claim. It changes no command or lifecycle state and never re-runs work.
// Provisioning creates the table; initialize is for independently initialized stores.
export class CooperativeSettlement {
  constructor(private db: SQL, private now: () => Date = () => new Date(), private runner?: CooperativeTransactionRunner) {}

  async initialize(): Promise<void> {
    await this.db`CREATE TABLE IF NOT EXISTS central_cooperative_settlements (
      command_id TEXT PRIMARY KEY REFERENCES central_cooperative_claims(command_id),
      request_id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('completed', 'failed', 'not-executed', 'unknown')),
      evidence TEXT NOT NULL, expected_sequence TEXT, at TEXT NOT NULL
    )`;
    await this.db`CREATE OR REPLACE FUNCTION central_block_settlement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'settlement is immutable'; END $$`;
    await this.db.begin(async (tx) => {
      const [lock] = await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      if (!lock) throw new Error("central command event lock row missing");
      await tx`DROP TRIGGER IF EXISTS central_block_settlement_mutation ON central_cooperative_settlements`;
      await tx`CREATE TRIGGER central_block_settlement_mutation BEFORE UPDATE OR DELETE ON central_cooperative_settlements FOR EACH ROW EXECUTE FUNCTION central_block_settlement_mutation()`;
    });
  }

  async get(principal: Principal, commandId: string): Promise<Settlement | null> {
    if (!principal || principal.role !== "operator" || !validId(principal.name)) throw new Error("access denied");
    if (!validId(commandId)) throw new CommandError("invalid", "invalid command ID");
    const query = async (db: SQL | TransactionSQL) => {
      const [row] = await db<Settlement[]>`SELECT command_id AS "commandId", request_id AS "requestId", actor, disposition, evidence, expected_sequence AS "expectedSequence", at FROM central_cooperative_settlements WHERE command_id = ${commandId}`;
      return row ?? null;
    };
    return this.runner ? this.runner(query) : query(this.db);
  }

  // expectedSequence is the latest lifecycle seq the operator saw, or null if there was none.
  async settle(principal: Principal, commandId: string, requestId: string, disposition: SettlementDisposition, evidence: string, expectedSequence: string | null): Promise<{ settlement: Settlement; created: boolean }> {
    if (!principal || principal.role !== "operator" || !validId(principal.name)) throw new Error("access denied");
    const actor = principal.name;
    if (!validId(commandId) || !validId(requestId) || !settlementDispositions.includes(disposition) || typeof evidence !== "string" || !evidence.trim() || evidence.length > 65536 || !evidence.isWellFormed() || evidence.includes("\0") || !validLifecycleSequence(expectedSequence)) throw new CommandError("invalid", "invalid settlement request");
    return (this.runner ?? ((operation) => this.db.begin(operation)))(async (tx) => {
      // Same lock as lifecycle reports and assertions, taken before any read.
      const [lock] = await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      if (!lock) throw new Error("central command event lock row missing");
      // The checks below need fresh snapshots after the lock wait.
      const [isolation] = await tx<{ level: string }[]>`SELECT current_setting('transaction_isolation') AS level`;
      if (isolation?.level !== "read committed") throw new Error("settlement requires READ COMMITTED");
      const [existing] = await tx<Settlement[]>`SELECT command_id AS "commandId", request_id AS "requestId", actor, disposition, evidence, expected_sequence AS "expectedSequence", at FROM central_cooperative_settlements WHERE request_id = ${requestId}`;
      if (existing) {
        if (existing.commandId !== commandId || existing.actor !== actor || existing.disposition !== disposition || existing.evidence !== evidence || existing.expectedSequence !== expectedSequence) throw new CommandError("conflict", "settlement request ID was used for a different intent");
        return { settlement: existing, created: false };
      }
      // No row lock on the incarnation or identity: lifecycle reports lock them before the
      // event lock, so locking them here could deadlock. Inactive and retired are permanent,
      // and both changes wait for an in-flight report's row locks, so a committed inactive
      // state means no report from that incarnation can still commit.
      const [claim] = await tx<{ live: boolean | null }[]>`SELECT (incarnation.active AND NOT identity.retired) AS live
        FROM central_cooperative_claims claim
        LEFT JOIN central_supervisor_incarnations_v2 incarnation ON incarnation.id = claim.incarnation_id
        LEFT JOIN central_supervisor_identities_v2 identity ON identity.principal_id = incarnation.principal_id
        WHERE claim.command_id = ${commandId}`;
      if (!claim) throw new CommandError("not_found", "claim not found");
      const [settled] = await tx`SELECT 1 FROM central_cooperative_settlements WHERE command_id = ${commandId}`;
      if (settled) throw new CommandError("conflict", "claim is already settled");
      if (claim.live !== false) throw new CommandError("conflict", "claiming incarnation is still active");
      const [latest] = await tx<{ seq: string }[]>`SELECT seq::text AS seq FROM central_cooperative_lifecycle_events WHERE command_id = ${commandId} ORDER BY seq DESC LIMIT 1`;
      if ((latest?.seq ?? null) !== expectedSequence) throw new CommandError("conflict", "stale lifecycle sequence");
      const at = this.now().toISOString();
      await tx`INSERT INTO central_cooperative_settlements (command_id, request_id, actor, disposition, evidence, expected_sequence, at) VALUES (${commandId}, ${requestId}, ${actor}, ${disposition}, ${evidence}, ${expectedSequence}, ${at})`;
      return { settlement: { commandId, requestId, actor, disposition, evidence, expectedSequence, at }, created: true };
    });
  }
}
