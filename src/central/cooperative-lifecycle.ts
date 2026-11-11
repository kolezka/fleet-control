import type { SQL } from "bun";
import type { CooperativeTransactionRunner } from "./incarnations.ts";
import { CommandError } from "../commands.ts";
import { supervisorIdentity, type Principal } from "./auth.ts";
import { SupervisorIncarnations, type IncarnationCredential } from "./incarnations.ts";

export type CooperativeStatus = "accepted" | "rejected" | "running" | "completed" | "failed";
export type CooperativeEvent = { commandId: string; requestId: string; status: CooperativeStatus; detail: string; at: string };

const transitions: Record<string, CooperativeStatus[]> = {
  claimed: ["accepted", "rejected"], accepted: ["running", "completed", "failed"],
  running: ["completed", "failed"], rejected: [], completed: [], failed: [],
};
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);

// Standalone storage only. A claim remains frozen in central_commands.
export class CooperativeLifecycle {
  constructor(private db: SQL, private incarnations: SupervisorIncarnations, private now: () => Date = () => new Date(), private runner?: CooperativeTransactionRunner) {}

  async initialize(): Promise<void> {
    await this.db`CREATE TABLE IF NOT EXISTS central_cooperative_lifecycle_events (
      seq BIGSERIAL PRIMARY KEY, command_id TEXT NOT NULL REFERENCES central_cooperative_claims(command_id),
      incarnation_id TEXT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL,
      detail TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (incarnation_id, request_id)
    )`;
  }

  async report(principal: Principal, credential: IncarnationCredential, commandId: string, requestId: string, status: CooperativeStatus, detail: string): Promise<CooperativeEvent> {
    if (!principal || principal.role !== "supervisor") throw new Error("access denied");
    const identity = supervisorIdentity(principal);
    if (![identity.principalId, identity.name, identity.hostId, identity.session].every(validId)) throw new Error("access denied");
    if (!validId(commandId) || !commandId.isWellFormed() || !validId(requestId) || !requestId.isWellFormed() || !["accepted", "rejected", "running", "completed", "failed"].includes(status) || typeof detail !== "string" || detail.length > 65536 || !detail.isWellFormed() || detail.includes("\0")) throw new CommandError("invalid", "invalid lifecycle request");
    return (this.runner ?? ((operation) => this.db.begin(operation)))(async (tx) => {
      if (!await this.incarnations.lockForClaim(tx, identity, credential)) throw new Error("access denied");
      await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      const [claim] = await tx`SELECT command_id FROM central_cooperative_claims WHERE command_id = ${commandId} AND incarnation_id = ${credential.incarnationId}`;
      if (!claim) throw new Error("access denied");
      const [existing] = await tx<CooperativeEvent[]>`SELECT command_id AS "commandId", request_id AS "requestId", status, detail, at FROM central_cooperative_lifecycle_events WHERE incarnation_id = ${credential.incarnationId} AND request_id = ${requestId}`;
      if (existing) {
        if (existing.commandId !== commandId || existing.status !== status || existing.detail !== detail) throw new CommandError("conflict", "lifecycle request ID was used for a different intent");
        return existing;
      }
      const [latest] = await tx<{ status: CooperativeStatus }[]>`SELECT status FROM central_cooperative_lifecycle_events WHERE command_id = ${commandId} ORDER BY seq DESC LIMIT 1`;
      const current = latest?.status ?? "claimed";
      if (!transitions[current]?.includes(status)) throw new CommandError("conflict", `${commandId} is ${current}; cannot become ${status}`);
      const at = this.now().toISOString();
      await tx`INSERT INTO central_cooperative_lifecycle_events (command_id, incarnation_id, request_id, status, detail, at) VALUES (${commandId}, ${credential.incarnationId}, ${requestId}, ${status}, ${detail}, ${at})`;
      return { commandId, requestId, status, detail, at };
    });
  }
}
