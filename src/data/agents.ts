// Managed agents and their state. The prompt itself lives in the fleet dir; only its size and hash are kept here.
import type { Database } from "bun:sqlite";
import type { Agent, AgentState } from "../domain/agents.ts";

// SQLite has no boolean; the column is 0 or 1.
const fromRow = (r: Agent): Agent => ({ ...r, orchestrator: Boolean(r.orchestrator) });

export class Agents {
  constructor(readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'claude' CHECK (kind IN ('claude', 'dsh')),
      cwd TEXT NOT NULL,
      model TEXT NOT NULL,
      orchestrator INTEGER NOT NULL DEFAULT 0 CHECK (orchestrator IN (0, 1)),
      prompt_sha256 TEXT NOT NULL,
      prompt_bytes INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'failed', 'stopping', 'stopped')),
      error TEXT,
      updated_at TEXT NOT NULL
    )`);
    // Tables made before DSH agents have no kind column; their rows are Claude Code agents.
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(agents)").all();
    if (!cols.some((c) => c.name === "kind")) db.run("ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'claude' CHECK (kind IN ('claude', 'dsh'))");
    // And rows from before orchestrators are plain agents.
    if (!cols.some((c) => c.name === "orchestrator")) db.run("ALTER TABLE agents ADD COLUMN orchestrator INTEGER NOT NULL DEFAULT 0 CHECK (orchestrator IN (0, 1))");
  }

  private static readonly columns = `name, kind, cwd, model, orchestrator, prompt_sha256 AS promptSha256, prompt_bytes AS promptBytes,
    created_by AS createdBy, created_at AS createdAt, state, error, updated_at AS updatedAt`;

  list(): Agent[] {
    return this.db.query<Agent, []>(`SELECT ${Agents.columns} FROM agents ORDER BY created_at, name`).all().map(fromRow);
  }

  get(name: string): Agent | null {
    const row = this.db.query<Agent, [string]>(`SELECT ${Agents.columns} FROM agents WHERE name = ?`).get(name);
    return row ? fromRow(row) : null;
  }

  // Inserts a new row or replaces a stopped or failed one, in one statement, so two starts cannot both win.
  claim(a: Agent): boolean {
    const r = this.db.query(`INSERT INTO agents (name, kind, cwd, model, orchestrator, prompt_sha256, prompt_bytes, created_by, created_at, state, error, updated_at)
      VALUES ($name, $kind, $cwd, $model, $orchestrator, $promptSha256, $promptBytes, $createdBy, $createdAt, $state, $error, $updatedAt)
      ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, cwd = excluded.cwd, model = excluded.model, orchestrator = excluded.orchestrator, prompt_sha256 = excluded.prompt_sha256,
        prompt_bytes = excluded.prompt_bytes, created_by = excluded.created_by, created_at = excluded.created_at,
        state = excluded.state, error = excluded.error, updated_at = excluded.updated_at
      WHERE agents.state IN ('failed', 'stopped')`).run({ ...a, orchestrator: a.orchestrator ? 1 : 0 });
    return r.changes === 1;
  }

  // Moves a row from one of the given states; false when it was in another state. With `attempt` (the
  // row's created_at) only that start of the agent moves, not a later one under the same name.
  transition(name: string, from: AgentState[], to: AgentState, error: string | null, at: string, attempt?: string): boolean {
    const marks = from.map(() => "?").join(", ");
    const same = attempt === undefined ? "" : " AND created_at = ?";
    const r = this.db.query(`UPDATE agents SET state = ?, error = ?, updated_at = ? WHERE name = ? AND state IN (${marks})${same}`)
      .run(to, error, at, name, ...from, ...(attempt === undefined ? [] : [attempt]));
    return r.changes === 1;
  }
}
