import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Commands } from "./commands.ts";
import { CommandError, MAX_ACTOR } from "../domain/commands.ts";

const input = { idempotencyKey: "key-0001", target: "alpha", text: "hello" };
const kind = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error instanceof CommandError ? error.kind : "other"; }
  return "no error";
};

test("a new command with an actor over the limit is refused and nothing is stored", () => {
  const db = new Database(":memory:");
  const commands = new Commands(db);
  expect(MAX_ACTOR).toBe(256);
  expect(kind(() => commands.submit({ ...input, actor: "a".repeat(MAX_ACTOR + 1) }))).toBe("invalid");
  expect(commands.list()).toEqual([]);
  expect(commands.events()).toEqual([]);
  const stored = commands.submit({ ...input, actor: "a".repeat(MAX_ACTOR) });
  expect(stored.created).toBe(true);
  expect(stored.command.actor).toHaveLength(MAX_ACTOR);
  db.close();
});

test("a record stored before the limit still replays, and only as the same intent", () => {
  const db = new Database(":memory:");
  const commands = new Commands(db);
  const old = "o".repeat(MAX_ACTOR + 500);
  const at = "2026-01-01T00:00:00.000Z";
  db.query("INSERT INTO commands (id, idempotency_key, target, actor, text, status, created_at, updated_at) VALUES ('cmd-old', ?, 'alpha', ?, 'hello', 'queued', ?, ?)").run(input.idempotencyKey, old, at, at);
  const replay = commands.submit({ ...input, actor: old });
  expect(replay.created).toBe(false);
  expect(replay.command.id).toBe("cmd-old");
  expect(kind(() => commands.submit({ ...input, actor: old + "x" }))).toBe("conflict");
  expect(kind(() => commands.submit({ ...input, actor: "short" }))).toBe("conflict");
  expect(commands.list()).toHaveLength(1);
  db.close();
});

test("a status change by an actor over the limit is refused without a write", () => {
  const db = new Database(":memory:");
  const commands = new Commands(db);
  const id = commands.submit({ ...input, actor: "operator" }).command.id;
  expect(kind(() => commands.transition(id, "accepted", "r".repeat(MAX_ACTOR + 1), "response"))).toBe("invalid");
  expect(commands.get(id).status).toBe("queued");
  expect(commands.events(id).map((event) => event.status)).toEqual(["queued"]);
  expect(commands.transition(id, "accepted", "r".repeat(MAX_ACTOR), "response").status).toBe("accepted");
  db.close();
});
