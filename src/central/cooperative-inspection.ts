import type { SQL } from "bun";
import { CommandError } from "../commands.ts";
import type { CentralCommand } from "./commands.ts";
import type { CooperativeStatus } from "./cooperative-lifecycle.ts";

export type CooperativeInspectionEvent = { seq: string; requestId: string; status: CooperativeStatus; detail: string; at: string };
export type CooperativeInspectionResult = {
  command: CentralCommand;
  claim: { incarnationId: string; requestId: string; createdAt: string } | null;
  events: CooperativeInspectionEvent[];
  nextCursor: string | null;
};

// The caller must authenticate and authorize the operator before calling this method.
// Pages are live reads, not a snapshot across calls. Command state is not lifecycle state.
export class CooperativeInspection {
  constructor(private db: SQL) {}

  async inspect(commandId: string, options: { limit?: number; cursor?: string } = {}): Promise<CooperativeInspectionResult | null> {
    if (typeof commandId !== "string" || !commandId || commandId.length > 256 || commandId.trim() !== commandId || /[\x00-\x1f\x7f]/.test(commandId)) throw new CommandError("invalid", "invalid command ID");
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CommandError("invalid", "invalid limit");
    const cursor = options.cursor ?? "0";
    if (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(cursor) || BigInt(cursor) > 9223372036854775807n) throw new CommandError("invalid", "invalid cursor");
    type Row = CentralCommand & { incarnationId: string | null; claimRequestId: string | null; claimCreatedAt: string | null; seq: string | null; eventRequestId: string | null; eventStatus: CooperativeStatus | null; eventDetail: string | null; eventAt: string | null };
    const rows = await this.db<Row[]>`SELECT c.id, c.idempotency_key AS "idempotencyKey", c.host_id AS "hostId", c.target, c.actor, c.text, c.status, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
      claim.incarnation_id AS "incarnationId", claim.request_id AS "claimRequestId", claim.created_at AS "claimCreatedAt",
      event.seq::text AS seq, event.request_id AS "eventRequestId", event.status AS "eventStatus", event.detail AS "eventDetail", event.at AS "eventAt"
      FROM central_commands c LEFT JOIN central_cooperative_claims claim ON claim.command_id = c.id
      LEFT JOIN LATERAL (SELECT seq, request_id, status, detail, at FROM central_cooperative_lifecycle_events
        WHERE command_id = c.id AND seq > ${cursor}::bigint ORDER BY seq LIMIT ${limit + 1}) event ON true
      WHERE c.id = ${commandId} ORDER BY event.seq`;
    const first = rows[0];
    if (!first) return null;
    const command: CentralCommand = { id: first.id, idempotencyKey: first.idempotencyKey, hostId: first.hostId, target: first.target, actor: first.actor, text: first.text, status: first.status, createdAt: first.createdAt, updatedAt: first.updatedAt };
    const claim = first.incarnationId === null ? null : { incarnationId: first.incarnationId, requestId: first.claimRequestId!, createdAt: first.claimCreatedAt! };
    const events = rows.filter((row) => row.seq !== null).map((row) => ({ seq: row.seq!, requestId: row.eventRequestId!, status: row.eventStatus!, detail: row.eventDetail!, at: row.eventAt! }));
    const hasMore = events.length > limit;
    if (hasMore) events.pop();
    return { command, claim, events, nextCursor: hasMore ? events[events.length - 1]!.seq : null };
  }
}
