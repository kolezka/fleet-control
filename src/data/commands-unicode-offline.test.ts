import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Commands } from "./commands";
import { CommandError } from "../domain/commands.ts";

describe("command Unicode persistence", () => {
  test("rejects malformed UTF-16 before lookup or write", () => {
    const db = new Database(":memory:");
    try {
      const commands = new Commands(db);
      const valid = { idempotencyKey: "key�", target: "session", actor: "actor�", text: "text�" };
      commands.submit(valid);
      const before = { commands: commands.list(), events: commands.events() };
      for (const field of ["idempotencyKey", "actor", "text"] as const) {
        for (const malformed of ["\ud800", "\udc00", "\ud800x", "\udc00\ud800"]) {
          const input = { ...valid, [field]: valid[field].replace("�", malformed) };
          try {
            commands.submit(input);
            throw new Error("expected malformed UTF-16 rejection");
          } catch (error) {
            expect(error).toBeInstanceOf(CommandError);
            expect((error as CommandError).kind).toBe("invalid");
          }
          expect(commands.list()).toEqual(before.commands);
          expect(commands.events()).toEqual(before.events);
        }
      }
    } finally {
      db.close();
    }
  });

  test("roundtrips and replays replacement characters and supplementary characters", () => {
    const db = new Database(":memory:");
    try {
      const commands = new Commands(db);
      const input = { idempotencyKey: "key�😀", target: "session", actor: "actor�😀", text: "text�😀" };
      const first = commands.submit(input);
      expect(first.created).toBe(true);
      expect(first.command).toMatchObject(input);
      const replay = commands.submit(input);
      expect(replay.created).toBe(false);
      expect(replay.command).toEqual(first.command);
      expect(commands.list()).toEqual([first.command]);
      expect(commands.events()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("rejects malformed replay against a previously normalized key", () => {
    const db = new Database(":memory:");
    try {
      const commands = new Commands(db);
      const stored = commands.submit({ idempotencyKey: "key�", target: "session", actor: "actor", text: "text" }).command;
      expect(() => commands.submit({ idempotencyKey: "key\ud800", target: "session", actor: "actor", text: "text" })).toThrow(CommandError);
      expect(commands.list()).toEqual([stored]);
      expect(commands.events()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("snapshots every input field once", () => {
    const db = new Database(":memory:");
    try {
      const commands = new Commands(db);
      const reads = { idempotencyKey: 0, target: 0, actor: 0, text: 0 };
      const input = {
        get idempotencyKey() { reads.idempotencyKey++; return "key"; },
        get target() { reads.target++; return "session"; },
        get actor() { reads.actor++; return "actor"; },
        get text() { reads.text++; return "text"; },
      };
      commands.submit(input);
      expect(reads).toEqual({ idempotencyKey: 1, target: 1, actor: 1, text: 1 });
    } finally {
      db.close();
    }
  });
});
