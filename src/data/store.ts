// Host-local registry of sessions Fleet Control knows about. Runtime truth still comes from the fleet CLI.
import { Database } from "bun:sqlite";
import type { ModelObservation, SessionKind } from "../domain/model.ts";
import type { SessionRecord } from "../domain/sessions.ts";

export class Store {
  readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { strict: true, create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      name TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('agent', 'script')),
      configured_model TEXT
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS model_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session TEXT NOT NULL REFERENCES sessions(name),
      runtime_instance TEXT NOT NULL,
      model TEXT NOT NULL,
      source TEXT NOT NULL,
      observed_at TEXT NOT NULL
    )`);
    // A row is added per new model turn and the session list reads the latest one per session on every refresh.
    this.db.run("CREATE INDEX IF NOT EXISTS model_observations_session ON model_observations (session, id)");
  }

  upsertSession(s: SessionRecord) {
    this.db
      .query(`INSERT INTO sessions (name, host, role, kind, configured_model)
        VALUES ($name, $host, $role, $kind, $configuredModel)
        ON CONFLICT(name) DO UPDATE SET host = excluded.host, role = excluded.role,
          kind = excluded.kind, configured_model = excluded.configured_model`)
      .run(s);
  }

  sessions(): SessionRecord[] {
    return this.db
      .query<SessionRecord, []>(
        "SELECT name, host, role, kind, configured_model AS configuredModel FROM sessions ORDER BY host, name",
      )
      .all();
  }

  recordObservation(session: string, o: ModelObservation) {
    this.db
      .query(`INSERT INTO model_observations (session, runtime_instance, model, source, observed_at)
        VALUES ($session, $runtimeInstance, $model, $source, $observedAt)`)
      .run({ session, ...o });
  }

  latestObservation(session: string): ModelObservation | null {
    return (
      this.db
        .query<ModelObservation, [string]>(
          `SELECT model, source, observed_at AS observedAt, runtime_instance AS runtimeInstance
           FROM model_observations WHERE session = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(session) ?? null
    );
  }
}
