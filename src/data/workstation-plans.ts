import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { checkEnrollRequest, EnrollError, type EnrollRequest } from '../domain/enrollment.ts';

function freshPlan(input: unknown): EnrollRequest {
  const plan = checkEnrollRequest(input);
  if (plan.mode !== 'fresh') throw new EnrollError('Only fresh installations can be saved as plans.');
  return plan;
}

// Reads only: a database without the plans table is an error here, never an empty list.
function readPlans(db: Database): EnrollRequest[] {
  return db.query<{id: string; body: string}, []>('SELECT id, body FROM workstation_plans ORDER BY id').all().map(row => {
    try {
      const plan = freshPlan(JSON.parse(row.body));
      if (plan.id !== row.id) throw new Error('id mismatch');
      return plan;
    } catch (cause) { throw new Error('invalid stored workstation plan', { cause }); }
  });
}

export function workstationPlans(db: Database) {
  db.run('CREATE TABLE IF NOT EXISTS workstation_plans (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)');
  const insert = db.query('INSERT INTO workstation_plans (id, body) VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
  return {
    save(input: unknown): void {
      const plan = freshPlan(input);
      if (!insert.run(plan.id, JSON.stringify(plan)).changes) throw new EnrollError('A workstation plan with this host id already exists.');
    },
    list: (): EnrollRequest[] => readPlans(db),
  };
}

// Opens the file for each call and closes it again, so a restarted gateway reads what the last one saved.
// Only saving creates the file or its table. Reading opens it read-only; no file yet means no plans.
export function workstationPlansFile(path: string) {
  return {
    save(input: unknown): void {
      const db = new Database(path, { create: true });
      try { workstationPlans(db).save(input); } finally { db.close(); }
    },
    list(): EnrollRequest[] {
      if (!existsSync(path)) return [];
      const db = new Database(path, { readonly: true });
      try { return readPlans(db); } finally { db.close(); }
    },
  };
}
