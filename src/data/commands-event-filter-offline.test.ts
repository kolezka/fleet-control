import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Commands } from "./commands";

describe("command event scope", () => {
  test("filters defined IDs, including an empty ID, and honors the cursor", () => {
    const db = new Database(":memory:");
    try {
      db.run("PRAGMA foreign_keys = ON");
      const commands = new Commands(db);
      const first = commands.submit({ idempotencyKey: "first", target: "session", actor: "operator", text: "first" }).command;
      const second = commands.submit({ idempotencyKey: "second", target: "session", actor: "operator", text: "second" }).command;
      const cursor = commands.events(first.id)[0]!.seq;

      expect(commands.events("", cursor)).toEqual([]);
      expect(commands.events(first.id, cursor)).toEqual([]);
      expect(commands.events(second.id, cursor).map((event) => event.commandId)).toEqual([second.id]);
      expect(commands.events(undefined, cursor).map((event) => event.commandId)).toEqual([second.id]);

      db.query("INSERT INTO commands (id, idempotency_key, target, actor, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("", "empty", "session", "operator", "empty", "queued", "now", "now");
      db.query("INSERT INTO command_events (command_id, status, actor, detail, at) VALUES (?, ?, ?, ?, ?)")
        .run("", "queued", "operator", "empty event", "now");
      expect(commands.events("", cursor).map((event) => event.commandId)).toEqual([""]);
      expect(commands.events(undefined, cursor).map((event) => event.commandId)).toEqual([second.id, ""]);
      expect(commands.events(first.id).map((event) => event.commandId)).toEqual([first.id]);
      expect(commands.events().map((event) => event.commandId)).toEqual([first.id, second.id, ""]);
    } finally {
      db.close();
    }
  });
});
