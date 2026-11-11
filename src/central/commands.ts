import type { SQL, TransactionSQL } from "bun";
import type { CooperativeTransactionRunner } from "./incarnations.ts";
import { CommandError, MAX_TEXT, type Command, type CommandStatus } from "../commands.ts";

export type CentralCommandEvent = { seq: string; commandId: string; status: CommandStatus; actor: string; detail: string; at: string };
export type CentralCommand = Command & { hostId: string };
export type CentralCommandInput = { idempotencyKey: string; hostId: string; target: string; actor: string; text: string };
export type CommandListScope = { hostId?: string; target?: string };
export type CommandListPagination = { limit?: number; cursor?: string };
export type CommandPage = { commands: CentralCommand[]; nextCursor: string | null };
export type SupervisorCommandScope = { hostId: string; session: string };
export type SupervisorReadGuard = (tx: TransactionSQL, scope: SupervisorCommandScope) => Promise<boolean>;

function decodeCursor(cursor: string): { createdAt: string; id: string; hostId: string | null; target: string | null; status: string | null } {
  try {
    if (typeof cursor !== "string" || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(text).toString("base64url") !== cursor) throw new Error();
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length !== 5 || typeof value[0] !== "string" || typeof value[1] !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value[0]) || new Date(value[0]).toISOString() !== value[0] || !/^cmd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value[1]) || !value.slice(2).every((item: unknown) => item === null || typeof item === "string")) throw new Error();
    return { createdAt: value[0], id: value[1], hostId: value[2], target: value[3], status: value[4] };
  } catch { throw new CommandError("invalid", "invalid cursor"); }
}

const MAX_SCOPE_LENGTH = 256;
// One rule for submit and list scope: a nonempty string of at most 256 characters.
const validScopeValue = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= MAX_SCOPE_LENGTH;

const allowed: Record<CommandStatus, CommandStatus[]> = {
  queued: ["delivering", "accepted", "rejected"],
  delivering: ["delivered", "delivery_unknown", "accepted", "rejected"],
  delivered: ["accepted", "rejected"],
  delivery_unknown: ["accepted", "rejected"],
  claimed: [],
  accepted: ["running", "completed", "failed"],
  running: ["completed", "failed"],
  rejected: [], completed: [], failed: [],
};

// Call initialize before use. The caller owns and closes the SQL pool.
export class CentralCommands {
  constructor(private db: SQL, private now: () => Date = () => new Date(), private runner?: CooperativeTransactionRunner) {}

  async initialize(): Promise<void> {
    await this.db`CREATE TABLE IF NOT EXISTS central_commands (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, host_id TEXT NOT NULL,
      target TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`;
    await this.db`CREATE TABLE IF NOT EXISTS central_command_events (
      seq BIGSERIAL PRIMARY KEY, command_id TEXT NOT NULL REFERENCES central_commands(id),
      status TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL
    )`;
    await this.db`CREATE TABLE IF NOT EXISTS central_command_event_lock (id INTEGER PRIMARY KEY CHECK (id = 1))`;
    await this.db`INSERT INTO central_command_event_lock (id) VALUES (1) ON CONFLICT DO NOTHING`;
  }

  async submit(input: CentralCommandInput): Promise<{ command: CentralCommand; created: boolean }> {
    const text = input.text.trim();
    if (!text) throw new CommandError("invalid", "instruction text is empty");
    if (text.length > MAX_TEXT) throw new CommandError("invalid", `instruction text is longer than ${MAX_TEXT} characters`);
    if (!validScopeValue(input.hostId)) throw new CommandError("invalid", `hostId is required and must be at most ${MAX_SCOPE_LENGTH} characters`);
    if (!validScopeValue(input.target) || !/^[A-Za-z0-9._-]+$/.test(input.target)) throw new CommandError("invalid", `invalid target session: ${String(input.target).slice(0, 64)}`);
    if (!input.idempotencyKey.trim() || !input.actor.trim()) throw new CommandError("invalid", "idempotencyKey and actor are required");
    return (this.runner ?? ((operation) => this.db.begin(operation)))(async (tx) => {
      // Serialize event writers until commit so a cursor never skips an earlier uncommitted sequence.
      await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      const [existing] = await tx<CentralCommand[]>`SELECT id, idempotency_key AS "idempotencyKey", host_id AS "hostId", target, actor, text, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM central_commands WHERE idempotency_key = ${input.idempotencyKey}`;
      if (existing) {
        if (existing.hostId !== input.hostId || existing.target !== input.target || existing.text !== text || existing.actor !== input.actor) {
          throw new CommandError("conflict", `idempotency key ${input.idempotencyKey} was used for a different command (${existing.id})`);
        }
        return { command: existing, created: false };
      }
      const at = this.now().toISOString();
      const id = `cmd-${crypto.randomUUID()}`;
      const [command] = await tx<CentralCommand[]>`INSERT INTO central_commands (id, idempotency_key, host_id, target, actor, text, status, created_at, updated_at)
        VALUES (${id}, ${input.idempotencyKey}, ${input.hostId}, ${input.target}, ${input.actor}, ${text}, 'queued', ${at}, ${at})
        RETURNING id, idempotency_key AS "idempotencyKey", host_id AS "hostId", target, actor, text, status, created_at AS "createdAt", updated_at AS "updatedAt"`;
      await tx`INSERT INTO central_command_events (command_id, status, actor, detail, at) VALUES (${id}, 'queued', ${input.actor}, 'stored on central server', ${at})`;
      return { command: command!, created: true };
    });
  }

  async transition(id: string, to: CommandStatus, actor: string, detail: string): Promise<CentralCommand> {
    return this.db.begin(async (tx) => {
      await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      const [current] = await tx<CentralCommand[]>`SELECT id, idempotency_key AS "idempotencyKey", host_id AS "hostId", target, actor, text, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM central_commands WHERE id = ${id} FOR UPDATE`;
      if (!current) throw new CommandError("not_found", `no command ${id}`);
      if (!allowed[current.status].includes(to)) throw new CommandError("conflict", `${id} is ${current.status}; cannot become ${to}`);
      const at = this.now().toISOString();
      await tx`UPDATE central_commands SET status = ${to}, updated_at = ${at} WHERE id = ${id}`;
      await tx`INSERT INTO central_command_events (command_id, status, actor, detail, at) VALUES (${id}, ${to}, ${actor}, ${detail}, ${at})`;
      return { ...current, status: to, updatedAt: at };
    });
  }

  // The guard must only perform transaction-bound work, before the event lock is acquired.
  async transitionScoped(id: string, to: "accepted" | "rejected" | "running" | "completed" | "failed", actor: string, detail: string, scope: { hostId: string; session: string }, guard: (tx: TransactionSQL) => Promise<boolean>): Promise<CentralCommand> {
    return this.db.begin(async (tx) => {
      if (!await guard(tx)) throw new Error("access denied");
      await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      const [current] = await tx<CentralCommand[]>`SELECT id, idempotency_key AS "idempotencyKey", host_id AS "hostId", target, actor, text, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM central_commands WHERE id = ${id} AND host_id = ${scope.hostId} AND target = ${scope.session} FOR UPDATE`;
      if (!current) throw new Error("access denied");
      if (!["accepted", "rejected", "running", "completed", "failed"].includes(to) || !allowed[current.status].includes(to)) throw new CommandError("conflict", `${id} is ${current.status}; cannot become ${to}`);
      const at = this.now().toISOString();
      await tx`UPDATE central_commands SET status = ${to}, updated_at = ${at} WHERE id = ${id}`;
      await tx`INSERT INTO central_command_events (command_id, status, actor, detail, at) VALUES (${id}, ${to}, ${actor}, ${detail}, ${at})`;
      return { ...current, status: to, updatedAt: at };
    });
  }

  // Only run once all previous delivery workers are known to be stopped.
  async reconcileAfterRestart(): Promise<string[]> {
    return this.db.begin(async (tx) => {
      await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      const at = this.now().toISOString();
      const stuck = await tx<{ id: string }[]>`UPDATE central_commands SET status = 'delivery_unknown', updated_at = ${at} WHERE status = 'delivering' RETURNING id`;
      for (const { id } of stuck) {
        await tx`INSERT INTO central_command_events (command_id, status, actor, detail, at) VALUES (${id}, 'delivery_unknown', 'service', 'service restarted during delivery', ${at})`;
      }
      return stuck.map(({ id }) => id);
    });
  }

  async get(id: string): Promise<CentralCommand> {
    const query = async (db: SQL | TransactionSQL) => {
      const [command] = await db<CentralCommand[]>`SELECT id, idempotency_key AS "idempotencyKey", host_id AS "hostId", target, actor, text, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM central_commands WHERE id = ${id}`;
      if (!command) throw new CommandError("not_found", `no command ${id}`);
      return command;
    };
    return this.runner ? this.runner(query) : query(this.db);
  }

  // Scope and guard must come from the same trusted supervisor identity. The guard
  // must acquire slot, identity and incarnation locks in lockForClaim order.
  async getScoped(id: string, scope: SupervisorCommandScope, guard: SupervisorReadGuard): Promise<CentralCommand> {
    const { hostId, session } = scope;
    return this.db.begin(async (tx) => {
      if (!await guard(tx, { hostId, session })) throw new Error("access denied");
      const [command] = await tx<CentralCommand[]>`SELECT id, idempotency_key AS "idempotencyKey", host_id AS "hostId", target, actor, text, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM central_commands WHERE id = ${id} AND host_id = ${hostId} AND target = ${session}`;
      if (!command) throw new Error("access denied");
      return command;
    });
  }

  async listScoped(status: CommandStatus | undefined, scope: SupervisorCommandScope, guard: SupervisorReadGuard, pagination: CommandListPagination = {}): Promise<CommandPage> {
    const { hostId, session } = scope;
    return this.db.begin(async (tx) => {
      if (!await guard(tx, { hostId, session })) throw new Error("access denied");
      return this.listWithConnection(tx, status, { hostId, target: session }, pagination);
    });
  }

  async eventsScoped(id: string, scope: SupervisorCommandScope, guard: SupervisorReadGuard, afterSeq = "0"): Promise<CentralCommandEvent[]> {
    const { hostId, session } = scope;
    return this.db.begin(async (tx) => {
      if (!await guard(tx, { hostId, session })) throw new Error("access denied");
      const [command] = await tx`SELECT id FROM central_commands WHERE id = ${id} AND host_id = ${hostId} AND target = ${session}`;
      if (!command) throw new Error("access denied");
      return this.eventsWithConnection(tx, id, afterSeq);
    });
  }

  async list(status?: CommandStatus, scope?: CommandListScope, pagination: CommandListPagination = {}): Promise<CommandPage> {
    return this.runner ? this.runner((tx) => this.listWithConnection(tx, status, scope, pagination)) : this.listWithConnection(this.db, status, scope, pagination);
  }

  private async listWithConnection(db: SQL | TransactionSQL, status?: CommandStatus, scope?: CommandListScope, pagination: CommandListPagination = {}): Promise<CommandPage> {
    if (status !== undefined && !Object.hasOwn(allowed, status)) throw new CommandError("invalid", "invalid status");
    if ((scope?.hostId !== undefined && !validScopeValue(scope.hostId)) || (scope?.target !== undefined && !validScopeValue(scope.target))) throw new CommandError("invalid", "invalid scope");
    const limit = pagination.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CommandError("invalid", "limit must be an integer between 1 and 1000");
    const cursor = pagination.cursor === undefined ? null : decodeCursor(pagination.cursor);
    const hostId = scope?.hostId ?? null;
    const target = scope?.target ?? null;
    const filterStatus = status ?? null;
    if (cursor && (cursor.hostId !== hostId || cursor.target !== target || cursor.status !== filterStatus)) throw new CommandError("invalid", "invalid cursor");
    const createdAt = cursor?.createdAt ?? null;
    const id = cursor?.id ?? null;
    const rows = await db<CentralCommand[]>`SELECT id, idempotency_key AS "idempotencyKey", host_id AS "hostId", target, actor, text, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM central_commands
      WHERE (${hostId}::text IS NULL OR host_id = ${hostId}) AND (${target}::text IS NULL OR target = ${target})
        AND (${filterStatus}::text IS NULL OR status = ${filterStatus})
        AND (${createdAt}::text IS NULL OR (created_at, id) > (${createdAt}, ${id}))
      ORDER BY created_at, id LIMIT ${limit + 1}`;
    const commands = rows.slice(0, limit);
    const last = commands[commands.length - 1];
    return { commands, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt, last.id, hostId, target, filterStatus])).toString("base64url") : null };
  }

  async events(id?: string, afterSeq = "0"): Promise<CentralCommandEvent[]> {
    return this.eventsWithConnection(this.db, id, afterSeq);
  }

  private async eventsWithConnection(db: SQL | TransactionSQL, id?: string, afterSeq = "0"): Promise<CentralCommandEvent[]> {
    if (typeof afterSeq !== "string" || !/^(0|[1-9][0-9]*)$/.test(afterSeq) || afterSeq.length > 19 || (afterSeq.length === 19 && afterSeq > "9223372036854775807")) throw new CommandError("invalid", "invalid event cursor");
    return id
      ? await db<CentralCommandEvent[]>`SELECT seq::text AS seq, command_id AS "commandId", status, actor, detail, at FROM central_command_events WHERE command_id = ${id} AND seq > ${afterSeq}::bigint ORDER BY central_command_events.seq`
      : await db<CentralCommandEvent[]>`SELECT seq::text AS seq, command_id AS "commandId", status, actor, detail, at FROM central_command_events WHERE seq > ${afterSeq}::bigint ORDER BY central_command_events.seq`;
  }
}
