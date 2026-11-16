import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Commands } from "./commands.ts";
import { Requests } from "./requests.ts";
import { Store } from "./store.ts";

// The page polls these every 3 s. Each must use an index, not scan the table, however long the history gets.
const plan = (db: Database, sql: string, ...args: (string | number)[]) =>
  db.query<{ detail: string }, (string | number)[]>("EXPLAIN QUERY PLAN " + sql).all(...args).map((r) => r.detail).join(" | ");

test("polled list queries use an index", () => {
  const db = new Database(":memory:");
  new Commands(db);
  new Requests(db);
  const cases = [
    plan(db, "SELECT id FROM commands ORDER BY created_at DESC, id DESC LIMIT ?", 6),
    plan(db, "SELECT seq FROM command_events WHERE command_id = ? AND seq > ? ORDER BY seq LIMIT ?", "c", 0, 100),
    plan(db, "SELECT id FROM requests WHERE status = 'open' ORDER BY created_at DESC, id DESC LIMIT ?", 1000),
    plan(db, "SELECT id FROM requests WHERE 1 = 1 ORDER BY created_at DESC, id DESC LIMIT ?", 1000),
  ];
  const store = new Store(":memory:");
  cases.push(plan(store.db, "SELECT model FROM model_observations WHERE session = ? ORDER BY id DESC LIMIT 1", "s"));
  for (const p of cases) {
    expect(p).toContain("USING");
    expect(p).not.toContain("TEMP B-TREE");
    expect(p).not.toMatch(/SCAN (commands|command_events|requests)$/);
  }
});

test("opening an existing database adds the indexes and keeps its rows", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE commands (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, target TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.run("INSERT INTO commands VALUES ('c1', 'k1', 'main', 'web', 'hi', 'queued', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
  const commands = new Commands(db);
  new Requests(db);
  const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  expect(names).toEqual(["command_events_command", "commands_created", "requests_created", "requests_status_created"]);
  expect(commands.latest(6).map((c) => c.id)).toEqual(["c1"]);
});
