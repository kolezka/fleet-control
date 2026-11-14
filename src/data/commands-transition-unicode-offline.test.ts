import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { CommandError, Commands } from "./commands";

function expectKind(action: () => unknown, kind: CommandError["kind"]) {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(CommandError);
  expect((error as CommandError).kind).toBe(kind);
}

test("transition rejects malformed audit fields without changing command or events", () => {
  const db = new Database(":memory:");
  try {
    const commands = new Commands(db);
    const { command } = commands.submit({ idempotencyKey: "key", target: "session", actor: "submitter", text: "work" });
    const before = { commands: commands.list(), events: commands.events() };
    for (const malformed of ["x\ud800", "x\udc00", "x\udc00\ud800", "x\ud800y"]) {
      for (const field of ["actor", "detail"] as const) {
        expectKind(() => commands.transition(command.id, "accepted", field === "actor" ? malformed : "actor", field === "detail" ? malformed : "detail"), "invalid");
        expect({ commands: commands.list(), events: commands.events() }).toEqual(before);
      }
    }
  } finally { db.close(); }
});

test("missing and conflicting transitions take precedence over malformed audit fields", () => {
  const db = new Database(":memory:");
  try {
    const commands = new Commands(db);
    const { command } = commands.submit({ idempotencyKey: "key", target: "session", actor: "submitter", text: "work" });
    const before = { commands: commands.list(), events: commands.events() };
    expectKind(() => commands.transition("missing", "accepted", "\ud800", "\udc00"), "not_found");
    expectKind(() => commands.transition(command.id, "completed", "\ud800", "\udc00"), "conflict");
    expect({ commands: commands.list(), events: commands.events() }).toEqual(before);
  } finally { db.close(); }
});

test("transition preserves valid supplementary and replacement characters", () => {
  const db = new Database(":memory:");
  try {
    const commands = new Commands(db);
    const { command } = commands.submit({ idempotencyKey: "key", target: "session", actor: "submitter", text: "work" });
    const result = commands.transition(command.id, "accepted", "actor 😀 �", "detail 𐐷 �");
    expect(result.status).toBe("accepted");
    expect(commands.events(command.id)).toHaveLength(2);
    expect(commands.events(command.id)[1]).toMatchObject({ status: "accepted", actor: "actor 😀 �", detail: "detail 𐐷 �" });
  } finally { db.close(); }
});
