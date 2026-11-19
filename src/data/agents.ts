// Managed agents and their state. The prompt itself lives in the fleet dir; only its size and hash are kept here.
import type { Database } from "bun:sqlite";
import type { Agent, AgentState } from "../domain/agents.ts";

export class Agents {
  constructor(readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_sha256 TEXT NOT NULL,
      prompt_bytes INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'failed', 'stopping', 'stopped')),
      error TEXT,
      updated_at TEXT NOT NULL
    )`);
  }

  private static readonly columns = `name, cwd, model, prompt_sha256 AS promptSha256, prompt_bytes AS promptBytes,
    created_by AS createdBy, created_at AS createdAt, state, error, updated_at AS updatedAt`;

  list(): Agent[] {
    return this.db.query<Agent, []>(`SELECT ${Agents.columns} FROM agents ORDER BY created_at, name`).all();
  }

  get(name: string): Agent | null {
    return this.db.query<Agent, [string]>(`SELECT ${Agents.columns} FROM agents WHERE name = ?`).get(name) ?? null;
  }

  // Inserts a new row or replaces a stopped or failed one, in one statement, so two starts cannot both win.
  claim(a: Agent): boolean {
    const r = this.db.query(`INSERT INTO agents (name, cwd, model, prompt_sha256, prompt_bytes, created_by, created_at, state, error, updated_at)
      VALUES ($name, $cwd, $model, $promptSha256, $promptBytes, $createdBy, $createdAt, $state, $error, $updatedAt)
      ON CONFLICT(name) DO UPDATE SET cwd = excluded.cwd, model = excluded.model, prompt_sha256 = excluded.prompt_sha256,
        prompt_bytes = excluded.prompt_bytes, created_by = excluded.created_by, created_at = excluded.created_at,
        state = excluded.state, error = excluded.error, updated_at = excluded.updated_at
      WHERE agents.state IN ('failed', 'stopped')`).run(a);
    return r.changes === 1;
  }

  // Moves a row from one of the given states; false when it was in another state.
  transition(name: string, from: AgentState[], to: AgentState, error: string | null, at: string): boolean {
    const marks = from.map(() => "?").join(", ");
    const r = this.db.query(`UPDATE agents SET state = ?, error = ?, updated_at = ? WHERE name = ? AND state IN (${marks})`)
      .run(to, error, at, name, ...from);
    return r.changes === 1;
  }
}
