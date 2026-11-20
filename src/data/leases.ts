// Input leases and their append-only events. A unique partial index allows one open lease per session.
import type { Database } from "bun:sqlite";
import { LeaseError, type Lease, type LeaseEvent, type LeaseEventKind } from "../domain/leases.ts";

const columns = `id, session, instance, holder, socket_id AS socketId, granted_at AS grantedAt, expires_at AS expiresAt,
  ended_at AS endedAt, end_reason AS endReason`;

export class Leases {
  constructor(readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS input_leases (
      id TEXT PRIMARY KEY,
      session TEXT NOT NULL,
      instance TEXT NOT NULL,
      holder TEXT NOT NULL,
      socket_id TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT
    )`);
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS input_leases_open ON input_leases (session) WHERE ended_at IS NULL");
    db.run(`CREATE TABLE IF NOT EXISTS lease_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      lease_id TEXT NOT NULL REFERENCES input_leases(id),
      kind TEXT NOT NULL CHECK (kind IN ('granted', 'input', 'ended')),
      bytes INTEGER,
      sha256 TEXT,
      detail TEXT NOT NULL,
      at TEXT NOT NULL
    )`);
  }

  // The lease not yet ended for this session, expired or not.
  open(session: string): Lease | null {
    return this.db.query<Lease, [string]>(`SELECT ${columns} FROM input_leases WHERE session = ? AND ended_at IS NULL`).get(session) ?? null;
  }

  openForSocket(socketId: string): Lease[] {
    return this.db.query<Lease, [string]>(`SELECT ${columns} FROM input_leases WHERE socket_id = ? AND ended_at IS NULL`).all(socketId);
  }

  openAll(): Lease[] {
    return this.db.query<Lease, []>(`SELECT ${columns} FROM input_leases WHERE ended_at IS NULL ORDER BY granted_at`).all();
  }

  get(id: string): Lease {
    const l = this.db.query<Lease, [string]>(`SELECT ${columns} FROM input_leases WHERE id = ?`).get(id);
    if (!l) throw new LeaseError("not_found", `no lease ${id}`);
    return l;
  }

  // Inserts the lease; a second open lease for the session is refused by the index.
  grant(l: Omit<Lease, "endedAt" | "endReason">, detail: string): Lease {
    return this.db.transaction(() => {
      try {
        this.db.query(`INSERT INTO input_leases (id, session, instance, holder, socket_id, granted_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(l.id, l.session, l.instance, l.holder, l.socketId, l.grantedAt, l.expiresAt);
      } catch (e) {
        if (e instanceof Error && /UNIQUE/.test(e.message)) throw new LeaseError("conflict", `${l.session} already has an input lease`);
        throw e;
      }
      this.event(l.id, "granted", null, null, detail, l.grantedAt);
      return this.get(l.id);
    })();
  }

  // Ends an open lease once; false when it had already ended.
  end(id: string, reason: string, at: string): boolean {
    return this.db.transaction(() => {
      const r = this.db.query("UPDATE input_leases SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL").run(at, reason, id);
      if (r.changes !== 1) return false;
      this.event(id, "ended", null, null, reason, at);
      return true;
    })();
  }

  recordInput(id: string, bytes: number, sha256: string, at: string): void {
    this.event(id, "input", bytes, sha256, "", at);
  }

  events(id: string): LeaseEvent[] {
    return this.db.query<LeaseEvent, [string]>(`SELECT seq, lease_id AS leaseId, kind, bytes, sha256, detail, at FROM lease_events WHERE lease_id = ? ORDER BY seq`).all(id);
  }

  private event(id: string, kind: LeaseEventKind, bytes: number | null, sha256: string | null, detail: string, at: string) {
    this.db.query("INSERT INTO lease_events (lease_id, kind, bytes, sha256, detail, at) VALUES (?, ?, ?, ?, ?, ?)").run(id, kind, bytes, sha256, detail, at);
  }
}
