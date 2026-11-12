import type { SQL, TransactionSQL } from "bun";
import { CommandError } from "../commands.ts";
import type { Principal } from "./auth.ts";
import type { CooperativeTransactionRunner } from "./incarnations.ts";

export type ReconciliationDisposition = "unknown" | "completed" | "failed" | "not-executed";
export type Reconciliation = { commandId: string; requestId: string; actor: string; disposition: ReconciliationDisposition; evidence: string; expectedSequence: string | null; sequence: string; supersedesSequence: string | null; at: string };

const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
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

  // Missing commands and claims both return null; a claim without assertions returns an empty page.
  // Pages are live reads, not a snapshot across calls.
  async list(principal: Principal, commandId: string, options: { limit?: number; cursor?: string } = {}): Promise<{ assertions: Reconciliation[]; nextCursor: string | null } | null> {
    if (!principal || principal.role !== "operator" || !validId(principal.name)) throw new Error("access denied");
    if (!validId(commandId)) throw new CommandError("invalid", "invalid command ID");
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CommandError("invalid", "invalid limit");
    const cursor = options.cursor ?? "0";
    if (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,999})$/.test(cursor)) throw new CommandError("invalid", "invalid cursor");
    type Row = { commandId: string; requestId: string | null; actor: string | null; disposition: ReconciliationDisposition | null; evidence: string | null; expectedSequence: string | null; sequence: string | null; supersedesSequence: string | null; at: string | null };
    const query = async (db: SQL | TransactionSQL) => {
      const rows = await db<Row[]>`SELECT claim.command_id AS "commandId", assertion.request_id AS "requestId", assertion.actor, assertion.disposition, assertion.evidence, assertion.expected_sequence AS "expectedSequence", assertion.sequence::text AS sequence, assertion.supersedes_sequence::text AS "supersedesSequence", assertion.at
        FROM central_cooperative_claims claim LEFT JOIN LATERAL (
          SELECT * FROM central_cooperative_reconciliations WHERE command_id = claim.command_id AND sequence > ${cursor}::numeric ORDER BY sequence LIMIT ${limit + 1}
        ) assertion ON true WHERE claim.command_id = ${commandId} ORDER BY assertion.sequence`;
      if (!rows.length) return null;
      const assertions = rows.filter((row) => row.sequence !== null).map((row): Reconciliation => ({ commandId: row.commandId, requestId: row.requestId!, actor: row.actor!, disposition: row.disposition!, evidence: row.evidence!, expectedSequence: row.expectedSequence, sequence: row.sequence!, supersedesSequence: row.supersedesSequence, at: row.at! }));
      const hasMore = assertions.length > limit;
      if (hasMore) assertions.pop();
      return { assertions, nextCursor: hasMore ? assertions[assertions.length - 1]!.sequence : null };
    };
    return this.runner ? this.runner(query) : query(this.db);
  }

  // HTTP-only bounded page. The existing list contract remains unchanged.
  async listBounded(principal: Principal, commandId: string, options: { limit: number; cursor?: string }): Promise<{ assertions: Reconciliation[]; nextCursor: string | null } | null> {
    if (!principal || principal.role !== "operator" || !validId(principal.name)) throw new Error("access denied");
    const limit = options.limit;
    if (!validId(commandId) || !Number.isInteger(limit) || limit < 1 || limit > 4) throw new CommandError("invalid", "invalid parameters");
    const cursor = options.cursor ?? "0";
    if (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,999})$/.test(cursor)) throw new CommandError("invalid", "invalid cursor");
    type Row = { present: boolean; oversized: boolean; commandId: string | null; requestId: string | null; actor: string | null; disposition: ReconciliationDisposition | null; evidence: string | null; expectedSequence: string | null; sequence: string | null; supersedesSequence: string | null; at: string | null };
    const query = async (db: SQL | TransactionSQL) => {
      // CASE prevents oversized fields crossing the database connection. One statement
      // gives the length check and values the same snapshot, including the extra row.
      const rows = await db<Row[]>`SELECT true AS present, assertion.oversized,
        CASE WHEN NOT assertion.oversized THEN claim.command_id END AS "commandId",
        CASE WHEN NOT assertion.oversized THEN assertion.request_id END AS "requestId",
        CASE WHEN NOT assertion.oversized THEN assertion.actor END AS actor,
        CASE WHEN NOT assertion.oversized THEN assertion.disposition END AS disposition,
        CASE WHEN NOT assertion.oversized THEN assertion.evidence END AS evidence,
        CASE WHEN NOT assertion.oversized THEN assertion.expected_sequence END AS "expectedSequence",
        CASE WHEN NOT assertion.oversized THEN assertion.sequence::text END AS sequence,
        CASE WHEN NOT assertion.oversized THEN assertion.supersedes_sequence::text END AS "supersedesSequence",
        CASE WHEN NOT assertion.oversized THEN assertion.at END AS at
        FROM central_cooperative_claims claim LEFT JOIN LATERAL (
          SELECT page.*, (octet_length(page.command_id) + octet_length(page.request_id) + octet_length(page.actor) + octet_length(page.disposition) + octet_length(page.evidence) + COALESCE(octet_length(page.expected_sequence), 0) + octet_length(page.sequence::text) + COALESCE(octet_length(page.supersedes_sequence::text), 0) + octet_length(page.at) > 270336) AS oversized
          FROM (SELECT * FROM central_cooperative_reconciliations WHERE command_id = claim.command_id AND sequence > ${cursor}::numeric ORDER BY sequence LIMIT ${limit + 1}) page
        ) assertion ON true WHERE claim.command_id = ${commandId} ORDER BY assertion.sequence`;
      if (!rows.length) return null;
      if (rows.some((row) => row.oversized)) throw new Error("assertion page too large");
      const assertions = rows.filter((row) => row.sequence !== null).map((row): Reconciliation => ({ commandId: row.commandId!, requestId: row.requestId!, actor: row.actor!, disposition: row.disposition!, evidence: row.evidence!, expectedSequence: row.expectedSequence, sequence: row.sequence!, supersedesSequence: row.supersedesSequence, at: row.at! }));
      const hasMore = assertions.length > limit;
      if (hasMore) assertions.pop();
      return { assertions, nextCursor: hasMore ? assertions[assertions.length - 1]!.sequence : null };
    };
    return this.runner ? this.runner(query) : query(this.db);
  }

  async reconcile(principal: Principal, commandId: string, requestId: string, disposition: ReconciliationDisposition, evidence: string, expectedSequence: string | null, expectedAssertionSequence: string | null): Promise<Reconciliation> {
    if (!principal || principal.role !== "operator") throw new Error("access denied");
    const actor = principal.name;
    if (!validId(actor)) throw new Error("access denied");
    if (!validId(commandId) || !validId(requestId) || !["unknown", "completed", "failed", "not-executed"].includes(disposition) || typeof evidence !== "string" || evidence.length > 65536 || !evidence.isWellFormed() || evidence.includes("\0") || !validSequence(expectedSequence) || !validSequence(expectedAssertionSequence)) throw new CommandError("invalid", "invalid reconciliation request");
    return (this.runner ?? ((operation) => this.db.begin(operation)))(async (tx) => {
      await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      const [existing] = await tx<Reconciliation[]>`SELECT command_id AS "commandId", request_id AS "requestId", actor, disposition, evidence, expected_sequence AS "expectedSequence", sequence::text AS sequence, supersedes_sequence::text AS "supersedesSequence", at FROM central_cooperative_reconciliations WHERE request_id = ${requestId}`;
      if (existing) {
        if (existing.commandId !== commandId || existing.actor !== actor || existing.disposition !== disposition || existing.evidence !== evidence || existing.expectedSequence !== expectedSequence || existing.supersedesSequence !== expectedAssertionSequence) throw new CommandError("conflict", "reconciliation request ID was used for a different intent");
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
      await tx`INSERT INTO central_cooperative_reconciliations (command_id, request_id, actor, disposition, evidence, expected_sequence, sequence, supersedes_sequence, at) VALUES (${commandId}, ${requestId}, ${actor}, ${disposition}, ${evidence}, ${expectedSequence}, ${sequence}::numeric, ${expectedAssertionSequence}::numeric, ${at})`;
      return { commandId, requestId, actor, disposition, evidence, expectedSequence, sequence, supersedesSequence: expectedAssertionSequence, at };
    });
  }
}
