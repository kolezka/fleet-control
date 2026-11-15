// Durable command queue. Each state change is a row in command_events, so the history survives restarts.
// Queued, delivered, accepted and completed are separate facts; none implies the next one.
import type { Database } from "bun:sqlite";
import { type CommandStatus, type Command, type CommandEvent, CommandError, commandTransitions, MAX_ACTOR, MAX_TEXT, sessionNamePattern } from "../domain/commands.ts";

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

  // A delivery cut off by a crash or restart may have reached the pane, so its outcome is unknown, not queued.
  // This covers a command the recipient answered before the sender returned: its status stays.
  reconcileAfterRestart(): string[] {
    // SQLite returns the other columns from the row that holds MAX(seq).
    const open = this.db.query<{ id: string; status: string }, []>(
      `SELECT command_id AS id, status, MAX(seq) FROM command_events WHERE status IN (${deliveryEvents}) GROUP BY command_id`,
    ).all().filter((row) => row.status === "delivering").map((row) => row.id);
    const stuck = [...new Set([...this.list("delivering").map((c) => c.id), ...open])];
    for (const id of stuck) this.deliveryOutcome(id, "delivery_unknown", "service restarted during delivery");
    return stuck;
  }

  // Records what the sender reported. If the recipient answered while the send was in flight,
  // the answer stands and the outcome is kept as an event only.
  deliveryOutcome(id: string, outcome: "delivered" | "delivery_unknown", detail: string): Command {
    return this.db.transaction(() => {
      const c = this.get(id);
      if (c.status === "delivering") return this.transition(id, outcome, "service", detail);
      const last = this.db.query<{ status: string }, [string]>(
        `SELECT status FROM command_events WHERE command_id = ? AND status IN (${deliveryEvents}) ORDER BY seq DESC LIMIT 1`,
      ).get(id);
      if (last?.status !== "delivering") throw new CommandError("conflict", `${id} is ${c.status}; no delivery is in progress`);
      if (!detail.isWellFormed()) throw new CommandError("invalid", "command event fields must contain valid Unicode");
      this.event(id, outcome, "service", detail, this.now().toISOString());
      return c;
    })();
  }

  submit(input: { idempotencyKey: string; target: string; actor: string; text: string }): { command: Command; created: boolean } {
    const { idempotencyKey, target, actor, text: rawText } = input;
    if (![idempotencyKey, actor, rawText].every((value) => value.isWellFormed())) {
      throw new CommandError("invalid", "command fields must contain valid Unicode");
    }
    const text = rawText.trim();
    if (!text) throw new CommandError("invalid", "instruction text is empty");
    if (text.length > MAX_TEXT) throw new CommandError("invalid", `instruction text is longer than ${MAX_TEXT} characters`);
    if (!sessionNamePattern.test(target)) throw new CommandError("invalid", `invalid target session: ${target}`);
    if (!idempotencyKey.trim() || !actor.trim()) throw new CommandError("invalid", "idempotencyKey and actor are required");

    return this.db.transaction(() => {
      const existing = this.byKey(idempotencyKey);
      if (existing) {
        // Same key, same intent: return the original. Same key, different intent: refuse.
        if (existing.target !== target || existing.text !== text || existing.actor !== actor) {
          throw new CommandError("conflict", `idempotency key ${idempotencyKey} was used for a different command (${existing.id})`);
        }
        return { command: existing, created: false };
      }
      // Checked after the replay lookup, so a record stored before this limit still replays.
      if (actor.length > MAX_ACTOR) throw new CommandError("invalid", `actor is longer than ${MAX_ACTOR} characters`);
      const at = this.now().toISOString();
      const id = `cmd-${crypto.randomUUID()}`;
      this.db
        .query(`INSERT INTO commands (id, idempotency_key, target, actor, text, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(id, idempotencyKey, target, actor, text, at, at);
      this.event(id, "queued", actor, "stored on host", at);
      return { command: this.get(id), created: true };
    })();
  }

  transition(id: string, to: CommandStatus, actor: string, detail: string): Command {
    return this.db.transaction(() => {
      const c = this.get(id);
      if (!commandTransitions[c.status].includes(to)) {
        throw new CommandError("conflict", `${id} is ${c.status}; cannot become ${to}`);
      }
      if (!actor.isWellFormed() || !detail.isWellFormed()) {
        throw new CommandError("invalid", "command event fields must contain valid Unicode");
      }
      if (actor.length > MAX_ACTOR) throw new CommandError("invalid", `actor is longer than ${MAX_ACTOR} characters`);
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
    return id !== undefined
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

// Events that open or close a delivery attempt.
const deliveryEvents = "'queued', 'delivering', 'delivered', 'delivery_unknown'";

const select = `SELECT id, idempotency_key AS idempotencyKey, target, actor, text, status,
  created_at AS createdAt, updated_at AS updatedAt FROM commands`;
