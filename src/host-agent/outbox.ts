import { Database } from "bun:sqlite";

export type HostReceipt = Readonly<{
  hostId: string;
  commandId: string;
  attemptId: string;
  status: "delivered" | "unknown";
}>;

export class OutboxError extends Error {
  constructor(readonly kind: "invalid" | "conflict" | "not_found", message: string) {
    super(message);
  }
}

function validate(receipt: HostReceipt): void {
  if (!receipt || ![receipt.hostId, receipt.commandId, receipt.attemptId].every((value) => typeof value === "string" && value.trim()) ||
      (receipt.status !== "delivered" && receipt.status !== "unknown")) {
    throw new OutboxError("invalid", "receipt requires host, command, attempt and terminal status");
  }
}

export class ReceiptOutbox {
  constructor(private readonly db: Database) {
    db.run("PRAGMA busy_timeout = 5000");
    db.run(`CREATE TABLE IF NOT EXISTS host_receipt_outbox (
      attempt_id TEXT PRIMARY KEY NOT NULL,
      host_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('delivered', 'unknown')),
      acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1))
    )`);
  }

  enqueue(receipt: HostReceipt): { created: boolean } {
    validate(receipt);
    return this.db.transaction(() => {
      const created = this.db.query("INSERT OR IGNORE INTO host_receipt_outbox (attempt_id, host_id, command_id, status) VALUES (?, ?, ?, ?)")
        .run(receipt.attemptId, receipt.hostId, receipt.commandId, receipt.status).changes === 1;
      this.requireMatching(receipt);
      return { created };
    }).immediate();
  }

  pending(): HostReceipt[] {
    return this.db.query<HostReceipt, []>(`SELECT host_id AS hostId, command_id AS commandId, attempt_id AS attemptId, status
      FROM host_receipt_outbox WHERE acknowledged = 0 ORDER BY rowid`).all();
  }

  acknowledge(receipt: HostReceipt): void {
    validate(receipt);
    this.db.transaction(() => {
      this.requireMatching(receipt);
      this.db.query("UPDATE host_receipt_outbox SET acknowledged = 1 WHERE attempt_id = ?").run(receipt.attemptId);
    }).immediate();
  }

  private requireMatching(receipt: HostReceipt): void {
    const stored = this.db.query<HostReceipt, [string]>(`SELECT host_id AS hostId, command_id AS commandId, attempt_id AS attemptId, status
      FROM host_receipt_outbox WHERE attempt_id = ?`).get(receipt.attemptId);
    if (!stored) throw new OutboxError("not_found", "receipt not found");
    if (stored.hostId !== receipt.hostId || stored.commandId !== receipt.commandId || stored.status !== receipt.status) {
      throw new OutboxError("conflict", "attempt receipt conflicts with stored content");
    }
  }
}
