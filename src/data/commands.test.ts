import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Commands } from "./commands.ts";
import { CommandError } from "../domain/commands.ts";

const input = { idempotencyKey: "key-0001", target: "supervisor", actor: "macbook", text: "run the tests" };
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

test("submit stores a queued command with one event", () => {
  const c = new Commands(new Database(":memory:"));
  const { command, created } = c.submit(input);
  expect(created).toBe(true);
  expect(command.status).toBe("queued");
  expect(c.events(command.id).map((e) => e.status)).toEqual(["queued"]);
});

test("same idempotency key and intent returns the original command", () => {
  const c = new Commands(new Database(":memory:"));
  const first = c.submit(input).command;
  const again = c.submit({ ...input, text: "  run the tests \n" });
  expect(again.created).toBe(false);
  expect(again.command.id).toBe(first.id);
  expect(c.list()).toHaveLength(1);
});

test("same idempotency key with a different intent is a conflict", () => {
  const c = new Commands(new Database(":memory:"));
  c.submit(input);
  expect(() => c.submit({ ...input, text: "deploy" })).toThrow(CommandError);
  expect(() => c.submit({ ...input, target: "worker" })).toThrow(/different command/);
});

test("invalid input is refused before storage", () => {
  const c = new Commands(new Database(":memory:"));
  expect(() => c.submit({ ...input, text: "   " })).toThrow(/empty/);
  expect(() => c.submit({ ...input, target: "a b" })).toThrow(/invalid target/);
  expect(() => c.submit({ ...input, text: "x".repeat(4001) })).toThrow(/longer/);
  expect(c.list()).toHaveLength(0);
});

test("delivery does not imply acceptance and completion needs acceptance first", () => {
  const c = new Commands(new Database(":memory:"));
  const id = c.submit(input).command.id;
  expect(() => c.transition(id, "completed", "supervisor", "done")).toThrow(/cannot become completed/);
  c.transition(id, "delivering", "service", "send");
  c.transition(id, "delivered", "service", "ok");
  expect(() => c.transition(id, "running", "supervisor", "go")).toThrow(/cannot become running/);
  c.transition(id, "accepted", "supervisor", "ok");
  c.transition(id, "completed", "supervisor", "tests pass");
  expect(() => c.transition(id, "failed", "supervisor", "late")).toThrow(/completed; cannot become failed/);
  expect(c.events(id).map((e) => e.status)).toEqual(["queued", "delivering", "delivered", "accepted", "completed"]);
});

test("claimed is readable but legacy transitions cannot enter or leave it", () => {
  const db = new Database(":memory:");
  const commands = new Commands(db);
  const id = commands.submit(input).command.id;
  expect(() => commands.transition(id, "claimed", "service", "reserve")).toThrow(/cannot become claimed/);
  db.query("UPDATE commands SET status = 'claimed' WHERE id = ?").run(id);
  expect(commands.get(id).status).toBe("claimed");
  expect(commands.list("claimed").map((command) => command.id)).toEqual([id]);
  for (const status of ["queued", "delivering", "delivered", "delivery_unknown", "claimed", "accepted", "rejected", "running", "completed", "failed"] as const) {
    expect(() => commands.transition(id, status, "service", "legacy transition")).toThrow(/cannot become/);
  }
  expect(commands.events(id).map((event) => event.status)).toEqual(["queued"]);
});

test("a delivery interrupted by a restart becomes delivery_unknown, not queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-control-cmd-"));
  dirs.push(dir);
  const path = join(dir, "state.db");
  const before = new Commands(new Database(path));
  const id = before.submit(input).command.id;
  before.transition(id, "delivering", "service", "send");

  const after = new Commands(new Database(path));
  expect(after.reconcileAfterRestart()).toEqual([id]);
  expect(after.get(id).status).toBe("delivery_unknown");
  expect(after.events(id).at(-1)?.detail).toMatch(/restarted/);
  // the record survived the restart, so the same key still dedupes
  expect(after.submit(input).created).toBe(false);
});

test("events can be read after a cursor", () => {
  const c = new Commands(new Database(":memory:"));
  const a = c.submit(input).command.id;
  const cursor = c.events().at(-1)!.seq;
  c.submit({ ...input, idempotencyKey: "key-0002" });
  c.transition(a, "rejected", "supervisor", "no");
  expect(c.events(undefined, cursor).map((e) => e.status)).toEqual(["queued", "rejected"]);
});
