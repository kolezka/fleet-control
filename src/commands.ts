// Durable command queue. Each state change is a row in command_events, so the history survives restarts.
// Queued, delivered, accepted and completed are separate facts; none implies the next one.
import type { Database } from "bun:sqlite";

export type CommandStatus =
  | "queued" // stored on the host; not yet shown to the recipient
  | "delivering" // a delivery attempt is in progress; after a crash this becomes delivery_unknown
  | "delivered" // fleet send confirmed the text appeared in the recipient pane
  | "delivery_unknown" // an attempt may or may not have reached the pane; never retried automatically
  | "accepted"
  | "rejected"
  | "running"
  | "completed"
  | "failed";

export type Command = {
  id: string;
  idempotencyKey: string;
  target: string;
  actor: string;
  text: string;
  status: CommandStatus;
  createdAt: string;
  updatedAt: string;
};

export type CommandEvent = { seq: number; commandId: string; status: CommandStatus; actor: string; detail: string; at: string };

export class CommandError extends Error {
  constructor(readonly kind: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
  }
}

// Who may move a command from which state. Delivery outcomes come only from the service itself.
const allowed: Record<CommandStatus, CommandStatus[]> = {
  queued: ["delivering", "accepted", "rejected"],
  delivering: ["delivered", "queued", "delivery_unknown"],
  delivered: ["accepted", "rejected"],
  delivery_unknown: ["accepted", "rejected"],
  accepted: ["running", "completed", "failed"],
  running: ["completed", "failed"],
  rejected: [],
  completed: [],
  failed: [],
};

export const MAX_TEXT = 4000;
const sessionName = /^[A-Za-z0-9._-]+$/;

export class Commands {
  constructor(
    private db: Database,
    private now: () => Date = () => new Date(),
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      target TEXT NOT NULL,
      actor TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS command_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL REFERENCES commands(id),
      status TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT NOT NULL,
      at TEXT NOT NULL
    )`);
  }

  // A delivery cut off by a crash or restart may have reached the pane, so it becomes unknown, not queued.
  reconcileAfterRestart(): string[] {
    const stuck = this.list("delivering").map((c) => c.id);
    for (const id of stuck) this.transition(id, "delivery_unknown", "service", "service restarted during delivery");
    return stuck;
  }

  submit(input: { idempotencyKey: string; target: string; actor: string; text: string }): { command: Command; created: boolean } {
    const text = input.text.trim();
    if (!text) throw new CommandError("invalid", "instruction text is empty");
    if (text.length > MAX_TEXT) throw new CommandError("invalid", `instruction text is longer than ${MAX_TEXT} characters`);
    if (!sessionName.test(input.target)) throw new CommandError("invalid", `invalid target session: ${input.target}`);
    if (!input.idempotencyKey.trim() || !input.actor.trim()) throw new CommandError("invalid", "idempotencyKey and actor are required");

    return this.db.transaction(() => {
      const existing = this.byKey(input.idempotencyKey);
      if (existing) {
        // Same key, same intent: return the original. Same key, different intent: refuse.
        if (existing.target !== input.target || existing.text !== text || existing.actor !== input.actor) {
          throw new CommandError("conflict", `idempotency key ${input.idempotencyKey} was used for a different command (${existing.id})`);
        }
        return { command: existing, created: false };
      }
      const at = this.now().toISOString();
      const id = `cmd-${crypto.randomUUID()}`;
      this.db
        .query(`INSERT INTO commands (id, idempotency_key, target, actor, text, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(id, input.idempotencyKey, input.target, input.actor, text, at, at);
      this.event(id, "queued", input.actor, "stored on host", at);
      return { command: this.get(id), created: true };
    })();
  }

  transition(id: string, to: CommandStatus, actor: string, detail: string): Command {
    return this.db.transaction(() => {
      const c = this.get(id);
      if (!allowed[c.status].includes(to)) {
        throw new CommandError("conflict", `${id} is ${c.status}; cannot become ${to}`);
      }
      const at = this.now().toISOString();
      this.db.query("UPDATE commands SET status = ?, updated_at = ? WHERE id = ?").run(to, at, id);
      this.event(id, to, actor, detail, at);
      return this.get(id);
    })();
  }

  get(id: string): Command {
    const c = this.db.query<Command, [string]>(`${select} WHERE id = ?`).get(id);
    if (!c) throw new CommandError("not_found", `no command ${id}`);
    return c;
  }

  list(status?: CommandStatus): Command[] {
    return status
      ? this.db.query<Command, [string]>(`${select} WHERE status = ? ORDER BY created_at, id`).all(status)
      : this.db.query<Command, []>(`${select} ORDER BY created_at, id`).all();
  }

  events(id?: string, afterSeq = 0): CommandEvent[] {
    const cols = "seq, command_id AS commandId, status, actor, detail, at";
    return id
      ? this.db.query<CommandEvent, [string, number]>(`SELECT ${cols} FROM command_events WHERE command_id = ? AND seq > ? ORDER BY seq`).all(id, afterSeq)
      : this.db.query<CommandEvent, [number]>(`SELECT ${cols} FROM command_events WHERE seq > ? ORDER BY seq`).all(afterSeq);
  }

  private byKey(key: string): Command | null {
    return this.db.query<Command, [string]>(`${select} WHERE idempotency_key = ?`).get(key) ?? null;
  }

  private event(id: string, status: CommandStatus, actor: string, detail: string, at: string) {
    this.db.query("INSERT INTO command_events (command_id, status, actor, detail, at) VALUES (?, ?, ?, ?, ?)").run(id, status, actor, detail, at);
  }
}

const select = `SELECT id, idempotency_key AS idempotencyKey, target, actor, text, status,
  created_at AS createdAt, updated_at AS updatedAt FROM commands`;
