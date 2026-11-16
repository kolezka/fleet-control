import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Commands } from "../src/data/commands.ts";
import { Requests } from "../src/data/requests.ts";
import { Store } from "../src/data/store.ts";
import { backup, tableDigests } from "./host-backup.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function stateDb() {
  const dir = mkdtempSync(join(tmpdir(), "host-backup-"));
  dirs.push(dir);
  const path = join(dir, "state.db");
  const store = new Store(path);
  const commands = new Commands(store.db);
  const requests = new Requests(store.db);
  for (let i = 0; i < 3; i++) commands.submit({ idempotencyKey: `k${i}`, target: "probe", actor: "tester", text: `text ${i}` });
  requests.registerRun({ runId: "run", orchestrator: "orchestrator", phase: "one" });
  return { dir, path, store };
}

test("backup writes a private copy whose rows equal the live database", () => {
  const { dir, path, store } = stateDb();
  const target = join(dir, "copy.db");
  const result = backup(path, target);
  expect(result.tables).toBeGreaterThanOrEqual(7);
  expect(result.rows).toBeGreaterThan(0);
  expect(statSync(target).mode & 0o777).toBe(0o600);
  const copy = new Database(target, { readonly: true });
  expect(tableDigests(copy)).toEqual(tableDigests(store.db));
  copy.close();
  store.db.close();
});

test("backup works while the service holds the database open and keeps writing", () => {
  const { dir, path, store } = stateDb();
  backup(path, join(dir, "a.db"));
  new Commands(store.db).submit({ idempotencyKey: "later", target: "probe", actor: "tester", text: "later" });
  const second = backup(path, join(dir, "b.db"));
  const first = new Database(join(dir, "a.db"), { readonly: true });
  expect(tableDigests(first).commands!.rows + 1).toBe(tableDigests(store.db).commands!.rows);
  expect(second.rows).toBeGreaterThan(0);
  first.close();
  store.db.close();
});

test("backup never overwrites an existing file", () => {
  const { dir, path, store } = stateDb();
  const target = join(dir, "exists.db");
  writeFileSync(target, "keep");
  expect(() => backup(path, target)).toThrow();
  expect(Bun.file(target).size).toBe(4);
  store.db.close();
});

test("digests change when one value changes, even with the same row count", () => {
  const { path, store } = stateDb();
  const before = tableDigests(store.db);
  store.db.run("UPDATE commands SET text = 'changed' WHERE idempotency_key = 'k1'");
  const after = tableDigests(store.db);
  expect(after.commands!.rows).toBe(before.commands!.rows);
  expect(after.commands!.sha256).not.toBe(before.commands!.sha256);
  store.db.close();
  void path;
});

test("an empty database is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "host-backup-"));
  dirs.push(dir);
  const empty = join(dir, "empty.db");
  new Database(empty).close();
  expect(() => backup(empty, join(dir, "copy.db"))).toThrow("no tables");
});
