import { Database } from 'bun:sqlite';
import { checkEnrollRequest, EnrollError, type EnrollRequest } from '../domain/enrollment.ts';

function freshPlan(input: unknown): EnrollRequest {
  const plan = checkEnrollRequest(input);
  if (plan.mode !== 'fresh') throw new EnrollError('Only fresh installations can be saved as plans.');
  return plan;
}

export function workstationPlans(db: Database) {
  db.run('CREATE TABLE IF NOT EXISTS workstation_plans (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)');
  const insert = db.query('INSERT INTO workstation_plans (id, body) VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
  const rows = db.query<{id: string; body: string}, []>('SELECT id, body FROM workstation_plans ORDER BY id');
  return {
    save(input: unknown): void {
      const plan = freshPlan(input);
      if (!insert.run(plan.id, JSON.stringify(plan)).changes) throw new EnrollError('A workstation plan with this host id already exists.');
    },
    list(): EnrollRequest[] {
      return rows.all().map(row => {
        try {
          const plan = freshPlan(JSON.parse(row.body));
          if (plan.id !== row.id) throw new Error('id mismatch');
          return plan;
        } catch (cause) { throw new Error('invalid stored workstation plan', { cause }); }
      });
    },
  };
}

// Opens the file for each call and closes it again, so a restarted gateway reads what the last one saved.
export function workstationPlansFile(path: string) {
  const use = <T>(run: (store: ReturnType<typeof workstationPlans>) => T): T => {
    const db = new Database(path, { create: true });
    try { return run(workstationPlans(db)); } finally { db.close(); }
  };
  return {
    save: (input: unknown): void => use(store => store.save(input)),
    list: (): EnrollRequest[] => use(store => store.list()),
  };
}
