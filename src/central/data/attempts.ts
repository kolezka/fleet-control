import type { SQL } from "bun";
import { CommandError } from "../../data/commands.ts";

export type DeliveryResult = "delivered" | "unknown";
export type CentralAttempt = { id: string; commandId: string; hostId: string; status: "started" | DeliveryResult; detail: string | null };

// Initialize CentralCommands first. The caller owns the SQL pool.
export class CentralAttempts {
  constructor(private db: SQL, private now: () => Date = () => new Date()) {}

  async initialize(): Promise<void> {
    await this.db`CREATE TABLE IF NOT EXISTS central_delivery_attempts (
      ordinal BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      command_id TEXT NOT NULL REFERENCES central_commands(id), host_id TEXT NOT NULL,
      status TEXT NOT NULL, detail TEXT
    )`;
    await this.db`ALTER TABLE central_delivery_attempts ADD COLUMN IF NOT EXISTS recovery_unknown BOOLEAN NOT NULL DEFAULT FALSE`;
  }

  // Call after command recovery, only when all previous delivery workers are stopped.
  async reconcileAfterRestart(): Promise<string[]> {
    return this.db.begin(async (tx) => {
      const rows = await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      if (!rows[0]) throw new Error("central command event lock row missing");
      const recovered = await tx<{ id: string; commandId: string; commandStatus: string }[]>`UPDATE central_delivery_attempts AS attempt
        SET status = 'unknown', detail = 'service restarted during delivery', recovery_unknown = TRUE
        FROM central_commands AS command
        WHERE attempt.command_id = command.id AND attempt.status = 'started' AND command.status IN ('delivery_unknown', 'accepted', 'running', 'completed', 'rejected', 'failed')
        RETURNING attempt.id, command.id AS "commandId", command.status AS "commandStatus"`;
      const at = this.now().toISOString();
      for (const attempt of recovered) {
        await tx`INSERT INTO central_command_events (command_id, status, actor, detail, at) VALUES (${attempt.commandId}, ${attempt.commandStatus}, 'service', ${`attempt ${attempt.id}: recovery unknown`}, ${at})`;
      }
      return recovered.map(({ id }) => id);
    });
  }

  // hostId is the authenticated host's scope, not a host supplied in the receipt.
  async begin(commandId: string, hostId: string): Promise<CentralAttempt> {
    if (!hostId.trim()) throw new CommandError("invalid", "hostId is required");
    return this.db.begin(async (tx) => {
      const rows = await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      if (!rows[0]) throw new Error("central command event lock row missing");
      const [command] = await tx<{ hostId: string; status: string }[]>`SELECT host_id AS "hostId", status FROM central_commands WHERE id = ${commandId} FOR UPDATE`;
      if (!command) throw new CommandError("not_found", `no command ${commandId}`);
      if (command.hostId !== hostId) throw new CommandError("conflict", "host does not match command");
      if (command.status !== "queued") throw new CommandError("conflict", `command ${commandId} is ${command.status}`);
      // A prior attempt may still have delivered, even if persisted state says queued.
      const [prior] = await tx<{ id: string }[]>`SELECT id FROM central_delivery_attempts WHERE command_id = ${commandId} LIMIT 1`;
      if (prior) throw new CommandError("conflict", `command ${commandId} already has a delivery attempt`);
      const id = `attempt-${crypto.randomUUID()}`;
      const at = this.now().toISOString();
      await tx`INSERT INTO central_delivery_attempts (id, command_id, host_id, status) VALUES (${id}, ${commandId}, ${hostId}, 'started')`;
      await tx`UPDATE central_commands SET status = 'delivering', updated_at = ${at} WHERE id = ${commandId}`;
      await tx`INSERT INTO central_command_events (command_id, status, actor, detail, at) VALUES (${commandId}, 'delivering', ${hostId}, ${id}, ${at})`;
      return { id, commandId, hostId, status: "started" as const, detail: null };
    });
  }

  async finish(commandId: string, hostId: string, attemptId: string, result: DeliveryResult, detail: string): Promise<CentralAttempt> {
    if (result !== "delivered" && result !== "unknown") throw new CommandError("invalid", "invalid delivery result");
    if (typeof detail !== "string") throw new CommandError("invalid", "delivery detail must be a string");
    return this.db.begin(async (tx) => {
      const rows = await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      if (!rows[0]) throw new Error("central command event lock row missing");
      const [command] = await tx<{ hostId: string; status: string }[]>`SELECT host_id AS "hostId", status FROM central_commands WHERE id = ${commandId} FOR UPDATE`;
      if (!command) throw new CommandError("not_found", `no command ${commandId}`);
      if (!hostId || command.hostId !== hostId) throw new CommandError("conflict", "host does not match command");
      const [row] = await tx<(CentralAttempt & { recoveryUnknown: boolean })[]>`SELECT id, command_id AS "commandId", host_id AS "hostId", status, detail, recovery_unknown AS "recoveryUnknown" FROM central_delivery_attempts WHERE command_id = ${commandId} ORDER BY ordinal DESC LIMIT 1 FOR UPDATE`;
      if (!row || row.id !== attemptId || row.hostId !== hostId) throw new CommandError("conflict", "attempt does not match current attempt");
      const { recoveryUnknown, ...attempt } = row;
      const commandStatus = result === "unknown" ? "delivery_unknown" : "delivered";
      if (attempt.status !== "started" && !recoveryUnknown) {
        if (attempt.status === result && attempt.detail === detail) return attempt;
        throw new CommandError("conflict", "receipt conflicts with attempt or command status");
      }
      if (!["delivering", "delivery_unknown", "accepted", "running", "completed", "rejected", "failed"].includes(command.status)) throw new CommandError("conflict", `command ${commandId} is ${command.status}`);
      const at = this.now().toISOString();
      await tx`UPDATE central_delivery_attempts SET status = ${result}, detail = ${detail}, recovery_unknown = FALSE WHERE id = ${attemptId}`;
      const advance = command.status === "delivering" || (command.status === "delivery_unknown" && result === "delivered");
      if (advance) await tx`UPDATE central_commands SET status = ${commandStatus}, updated_at = ${at} WHERE id = ${commandId}`;
      await tx`INSERT INTO central_command_events (command_id, status, actor, detail, at) VALUES (${commandId}, ${advance ? commandStatus : command.status}, ${hostId}, ${`receipt ${attemptId}: ${result}; ${detail}`}, ${at})`;
      return { ...attempt, status: result, detail };
    });
  }
}
