import type { SQL, TransactionSQL } from "bun";
import type { CooperativeTransactionRunner } from "./incarnations.ts";
import { CommandError } from "../commands.ts";
import type { CentralCommand } from "./commands.ts";
import type { CooperativeStatus } from "./cooperative-lifecycle.ts";

export type CooperativeInspectionEvent = { seq: string; requestId: string; status: CooperativeStatus; detail: string; at: string };
export type CooperativeInspectionResult = {
  command: CentralCommand;
  // incarnationActive is read with the claim. A false value means nobody can report on this claim any more.
  claim: { incarnationId: string; incarnationActive: boolean; requestId: string; createdAt: string } | null;
  events: CooperativeInspectionEvent[];
  nextCursor: string | null;
};

// The caller must authenticate and authorize the operator before calling this method.
// Pages are live reads, not a snapshot across calls. Command state is not lifecycle state.
export class CooperativeInspection {
  constructor(private db: SQL, private runner?: CooperativeTransactionRunner) {}

  async inspect(commandId: string, options: { limit?: number; cursor?: string } = {}): Promise<CooperativeInspectionResult | null> {
    if (typeof commandId !== "string" || !commandId || commandId.length > 256 || !commandId.isWellFormed() || commandId.trim() !== commandId || /[\x00-\x1f\x7f]/.test(commandId)) throw new CommandError("invalid", "invalid command ID");
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CommandError("invalid", "invalid limit");
    const cursor = options.cursor ?? "0";
    if (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(cursor) || BigInt(cursor) > 9223372036854775807n) throw new CommandError("invalid", "invalid cursor");
    type Row = CentralCommand & { incarnationId: string | null; incarnationActive: boolean | null; claimRequestId: string | null; claimCreatedAt: string | null; seq: string | null; eventRequestId: string | null; eventStatus: CooperativeStatus | null; eventDetail: string | null; eventAt: string | null };
    const query = async (db: SQL | TransactionSQL) => {
    const rows = await db<Row[]>`SELECT c.id, c.idempotency_key AS "idempotencyKey", c.host_id AS "hostId", c.target, c.actor, c.text, c.status, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
      claim.incarnation_id AS "incarnationId", incarnation.active AS "incarnationActive", claim.request_id AS "claimRequestId", claim.created_at AS "claimCreatedAt",
      event.seq::text AS seq, event.request_id AS "eventRequestId", event.status AS "eventStatus", event.detail AS "eventDetail", event.at AS "eventAt"
      FROM central_commands c LEFT JOIN central_cooperative_claims claim ON claim.command_id = c.id
        LEFT JOIN central_supervisor_incarnations_v2 incarnation ON incarnation.id = claim.incarnation_id
      LEFT JOIN LATERAL (SELECT seq, request_id, status, detail, at FROM central_cooperative_lifecycle_events
        WHERE command_id = c.id AND seq > ${cursor}::bigint ORDER BY seq LIMIT ${limit + 1}) event ON true
      WHERE c.id = ${commandId} ORDER BY event.seq`;
    const first = rows[0];
    if (!first) return null;
    const command: CentralCommand = { id: first.id, idempotencyKey: first.idempotencyKey, hostId: first.hostId, target: first.target, actor: first.actor, text: first.text, status: first.status, createdAt: first.createdAt, updatedAt: first.updatedAt };
    const claim = first.incarnationId === null ? null : { incarnationId: first.incarnationId, incarnationActive: first.incarnationActive === true, requestId: first.claimRequestId!, createdAt: first.claimCreatedAt! };
    const events = rows.filter((row) => row.seq !== null).map((row) => ({ seq: row.seq!, requestId: row.eventRequestId!, status: row.eventStatus!, detail: row.eventDetail!, at: row.eventAt! }));
    const hasMore = events.length > limit;
    if (hasMore) events.pop();
    return { command, claim, events, nextCursor: hasMore ? events[events.length - 1]!.seq : null };
    };
    return this.runner ? this.runner(query) : query(this.db);
  }

  // HTTP-only bounded page. The existing inspect contract remains unchanged.
  async inspectBounded(commandId: string, options: { limit: number; cursor?: string }): Promise<CooperativeInspectionResult | null> {
    if (typeof commandId !== "string" || !commandId || commandId.length > 256 || !commandId.isWellFormed() || commandId.trim() !== commandId || /[\x00-\x1f\x7f]/.test(commandId)) throw new CommandError("invalid", "invalid command ID");
    const limit = options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new CommandError("invalid", "invalid limit");
    const cursor = options.cursor ?? "0";
    if (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(cursor) || BigInt(cursor) > 9223372036854775807n) throw new CommandError("invalid", "invalid cursor");
    type Row = CentralCommand & { oversized: boolean; incarnationId: string | null; incarnationActive: boolean | null; claimRequestId: string | null; claimCreatedAt: string | null; seq: string | null; eventRequestId: string | null; eventStatus: CooperativeStatus | null; eventDetail: string | null; eventAt: string | null };
    const query = async (db: SQL | TransactionSQL) => {
      // Check all fields and the lookahead in the same statement that reads them.
      const rows = await db<Row[]>`SELECT size.oversized,
        CASE WHEN NOT size.oversized THEN c.id END AS id,
        CASE WHEN NOT size.oversized THEN c.idempotency_key END AS "idempotencyKey",
        CASE WHEN NOT size.oversized THEN c.host_id END AS "hostId",
        CASE WHEN NOT size.oversized THEN c.target END AS target,
        CASE WHEN NOT size.oversized THEN c.actor END AS actor,
        CASE WHEN NOT size.oversized THEN c.text END AS text,
        CASE WHEN NOT size.oversized THEN c.status END AS status,
        CASE WHEN NOT size.oversized THEN c.created_at END AS "createdAt",
        CASE WHEN NOT size.oversized THEN c.updated_at END AS "updatedAt",
        CASE WHEN NOT size.oversized THEN claim.incarnation_id END AS "incarnationId",
        CASE WHEN NOT size.oversized THEN incarnation.active END AS "incarnationActive",
        CASE WHEN NOT size.oversized THEN claim.request_id END AS "claimRequestId",
        CASE WHEN NOT size.oversized THEN claim.created_at END AS "claimCreatedAt",
        CASE WHEN NOT size.oversized THEN event.seq::text END AS seq,
        CASE WHEN NOT size.oversized THEN event.request_id END AS "eventRequestId",
        CASE WHEN NOT size.oversized THEN event.status END AS "eventStatus",
        CASE WHEN NOT size.oversized THEN event.detail END AS "eventDetail",
        CASE WHEN NOT size.oversized THEN event.at END AS "eventAt"
        FROM central_commands c LEFT JOIN central_cooperative_claims claim ON claim.command_id = c.id
        LEFT JOIN central_supervisor_incarnations_v2 incarnation ON incarnation.id = claim.incarnation_id
        LEFT JOIN LATERAL (SELECT seq, request_id, status, detail, at FROM central_cooperative_lifecycle_events
          WHERE command_id = c.id AND seq > ${cursor}::bigint ORDER BY seq LIMIT ${limit + 1}) event ON true
        CROSS JOIN LATERAL (SELECT (octet_length(c.id) + octet_length(c.idempotency_key) + octet_length(c.host_id) + octet_length(c.target) + octet_length(c.actor) + octet_length(c.text) + octet_length(c.status) + octet_length(c.created_at) + octet_length(c.updated_at) + COALESCE(octet_length(claim.incarnation_id), 0) + COALESCE(octet_length(claim.request_id), 0) + COALESCE(octet_length(claim.created_at), 0) + COALESCE(octet_length(event.seq::text), 0) + COALESCE(octet_length(event.request_id), 0) + COALESCE(octet_length(event.status), 0) + COALESCE(octet_length(event.detail), 0) + COALESCE(octet_length(event.at), 0) > 270336) AS oversized) size
        WHERE c.id = ${commandId} ORDER BY event.seq`;
      const first = rows[0];
      if (!first) return null;
      if (rows.some((row) => row.oversized)) throw new Error("inspection page too large");
      const command: CentralCommand = { id: first.id, idempotencyKey: first.idempotencyKey, hostId: first.hostId, target: first.target, actor: first.actor, text: first.text, status: first.status, createdAt: first.createdAt, updatedAt: first.updatedAt };
      const claim = first.incarnationId === null ? null : { incarnationId: first.incarnationId, incarnationActive: first.incarnationActive === true, requestId: first.claimRequestId!, createdAt: first.claimCreatedAt! };
      const events = rows.filter((row) => row.seq !== null).map((row) => ({ seq: row.seq!, requestId: row.eventRequestId!, status: row.eventStatus!, detail: row.eventDetail!, at: row.eventAt! }));
      const hasMore = events.length > limit;
      if (hasMore) events.pop();
      return { command, claim, events, nextCursor: hasMore ? events[events.length - 1]!.seq : null };
    };
    return this.runner ? this.runner(query) : query(this.db);
  }
}