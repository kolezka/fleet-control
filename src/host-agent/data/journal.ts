import { Database } from "bun:sqlite";
import type { DeliveryAttempt } from "../domain/delivery.ts";

export class JournalError extends Error {
  constructor(readonly kind: "invalid" | "conflict" | "not_found", message: string) {
    super(message);
  }
}

export type JournalLease = { readonly held: boolean };

export class DeliveryJournal {
  // Holding the lease here keeps it reachable for as long as the journal is.
  constructor(private db: Database, private lease?: JournalLease) {
    db.run("PRAGMA busy_timeout = 5000");
    db.run(`CREATE TABLE IF NOT EXISTS host_delivery_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('started', 'delivered', 'unknown'))
    )`);
  }

  private requireNoTransaction(): void {
    if (this.lease && !this.lease.held) throw new Error("delivery journal executor lease was released");
    if (this.db.inTransaction) throw new Error("delivery journal requires a connection outside a transaction");
  }

  start(id: string, fingerprint: string): { authorized: boolean; attempt: DeliveryAttempt } {
    this.requireNoTransaction();
    if (typeof id !== "string" || !id.isWellFormed() || !id.trim() || typeof fingerprint !== "string" || !fingerprint.isWellFormed() || !fingerprint.trim()) {
      throw new JournalError("invalid", "attempt id and intent fingerprint are required");
    }
    return this.db.transaction(() => {
      const inserted = this.db.query("INSERT OR IGNORE INTO host_delivery_attempts (id, fingerprint, status) VALUES (?, ?, 'started')").run(id, fingerprint).changes === 1;
      const attempt = this.get(id)!;
      if (attempt.fingerprint !== fingerprint) throw new JournalError("conflict", `attempt ${id} has a different intent`);
      return { authorized: inserted, attempt };
    }).immediate();
  }

  findIntent(id: string, fingerprint: string): DeliveryAttempt | null {
    if (typeof fingerprint !== "string" || !fingerprint.isWellFormed()) throw new JournalError("invalid", "invalid intent fingerprint");
    const attempt = this.get(id);
    if (attempt && attempt.fingerprint !== fingerprint) throw new JournalError("conflict", `attempt ${id} has a different intent`);
    return attempt;
  }

  get(id: string): DeliveryAttempt | null {
    if (typeof id !== "string" || !id.isWellFormed()) throw new JournalError("invalid", "invalid attempt id");
    return this.db.query<DeliveryAttempt, [string]>("SELECT id, fingerprint, status FROM host_delivery_attempts WHERE id = ?").get(id);
  }

  finish(id: string, status: "delivered" | "unknown"): DeliveryAttempt {
    this.requireNoTransaction();
    if (typeof id !== "string" || !id.isWellFormed()) throw new JournalError("invalid", "invalid attempt id");
    if (status !== "delivered" && status !== "unknown") throw new JournalError("invalid", "invalid outcome");
    return this.db.transaction(() => {
      const changed = this.db.query("UPDATE host_delivery_attempts SET status = ? WHERE id = ? AND status = 'started'").run(status, id).changes;
      const attempt = this.get(id);
      if (!attempt) throw new JournalError("not_found", `attempt ${id} not found`);
      if (!changed) throw new JournalError("conflict", `attempt ${id} is already ${attempt.status}`);
      return attempt;
    }).immediate();
  }

  // Safe only while no other executor is active: open through openExclusiveJournal
  // (executor-lease.ts). No runtime does that yet.
  reconcileAfterRestart(): number {
    this.requireNoTransaction();
    return this.db.query("UPDATE host_delivery_attempts SET status = 'unknown' WHERE status = 'started'").run().changes;
  }
}
