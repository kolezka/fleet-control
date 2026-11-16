import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Commands } from "../src/data/commands.ts";
import { Requests } from "../src/data/requests.ts";
import { Store } from "../src/data/store.ts";
import { backup } from "./host-backup.ts";
import { restoreCheck } from "./host-restore-check.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function backupFile(commandCount = 3) {
  const dir = mkdtempSync(join(tmpdir(), "host-restore-"));
  dirs.push(dir);
  const store = new Store(join(dir, "state.db"));
  const commands = new Commands(store.db);
  const requests = new Requests(store.db);
  for (let i = 0; i < commandCount; i++) commands.submit({ idempotencyKey: `k${i}`, target: "probe", actor: "tester", text: `text ${i}` });
  requests.registerRun({ runId: "run", orchestrator: "orchestrator", phase: "one" });
  const target = join(dir, "copy.db");
  const { sha256 } = backup(join(dir, "state.db"), target);
  store.db.close();
  return { dir, target, sha256 };
}

test("a fresh backup opens with the service stores, every list reads, and the file is untouched", () => {
  const { target, sha256 } = backupFile(1205);
  const bytes = readFileSync(target);
  const r = restoreCheck(target, sha256);
  expect(r.counts).toEqual({ sessions: 0, commands: 1205, runs: 1, requests: 0 });
  expect(r.addedTables).toEqual([]);
  expect(readFileSync(target).equals(bytes)).toBe(true);
});

test("a wrong expected checksum is refused before anything is opened", () => {
  const { target } = backupFile();
  expect(() => restoreCheck(target, "0".repeat(64))).toThrow("differs from the expected");
});

test("an older backup without the request tables passes and names the tables the service would add", () => {
  const { target } = backupFile();
  const db = new Database(target);
  db.run("DROP TABLE request_events");
  db.close();
  expect(restoreCheck(target).addedTables).toEqual(["request_events"]);
});

test("a corrupt file is refused", () => {
  const { dir, target } = backupFile();
  const bytes = readFileSync(target);
  bytes.fill(7, 4096, 8192);
  const bad = join(dir, "bad.db");
  writeFileSync(bad, bytes);
  expect(() => restoreCheck(bad)).toThrow();
});
