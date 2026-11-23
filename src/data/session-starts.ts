// Saved start commands for sessions that are not agents: one row per session name.
import type { Database } from "bun:sqlite";
import type { SessionStart } from "../domain/fleet-admin.ts";

const columns = "session, command, cwd, saved_by AS savedBy, saved_at AS savedAt";

export class SessionStarts {
  constructor(readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS session_starts (
      session TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      saved_by TEXT NOT NULL,
      saved_at TEXT NOT NULL
    )`);
  }

  list(): SessionStart[] {
    return this.db.query(`SELECT ${columns} FROM session_starts ORDER BY session`).all() as SessionStart[];
  }

  get(session: string): SessionStart | null {
    return (this.db.query(`SELECT ${columns} FROM session_starts WHERE session = ?`).get(session) as SessionStart | null) ?? null;
  }

  save(s: SessionStart): void {
    this.db.query(`INSERT INTO session_starts (session, command, cwd, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session) DO UPDATE SET command = excluded.command, cwd = excluded.cwd, saved_by = excluded.saved_by, saved_at = excluded.saved_at`)
      .run(s.session, s.command, s.cwd, s.savedBy, s.savedAt);
  }

  remove(session: string): boolean {
    return this.db.query("DELETE FROM session_starts WHERE session = ?").run(session).changes > 0;
  }
}
