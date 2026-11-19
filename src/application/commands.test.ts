import { expect, test } from "bun:test";
import { Commands } from "../data/commands.ts";
import { Store } from "../data/store.ts";
import type { Sender } from "../domain/delivery.ts";
import { commandUseCases } from "./commands.ts";
import { Deliverer } from "./delivery.ts";

function fixture() {
  const sent: string[] = [];
  const send: Sender = async (session) => { sent.push(session); return { exitCode: 0, stdout: `${session}: delivered`, stderr: "" }; };
  const commands = new Commands(new Store(":memory:").db);
  return { commands, sent, use: commandUseCases({ commands, deliverer: new Deliverer(commands, send) }) };
}
const input = { idempotencyKey: "key-00000001", target: "worker", actor: "tester", text: "run the tests" };
const statuses = (events: { status: string }[]) => events.map((event) => event.status);

test("a new submission is delivered once and returned with its history", async () => {
  const { use, sent } = fixture();
  const result = await use.submit(input);
  expect(result.created).toBe(true);
  expect(result.command.status).toBe("delivered");
  expect(statuses(result.events)).toEqual(["queued", "delivering", "delivered"]);
  expect(sent).toEqual(["worker"]);
});

test("a repeated key returns the original command and sends nothing again", async () => {
  const { use, sent } = fixture();
  const first = await use.submit(input);
  const again = await use.submit(input);
  expect(again.created).toBe(false);
  expect(again.command).toEqual(first.command);
  expect(again.events).toEqual(first.events);
  expect(sent).toEqual(["worker"]);
});

test("deliver and read return the command with the same history", async () => {
  const { use, commands, sent } = fixture();
  const { command } = commands.submit(input);
  expect(statuses(use.read(command.id).events)).toEqual(["queued"]);
  const delivered = await use.deliver(command.id);
  expect(delivered.command.status).toBe("delivered");
  expect(statuses(delivered.events)).toEqual(["queued", "delivering", "delivered"]);
  expect(use.read(command.id)).toEqual(delivered);
  expect(sent).toEqual(["worker"]);
});

test("list and eventsAfter read every command, optionally by status or after a cursor", async () => {
  const { use } = fixture();
  const first = await use.submit(input);
  const second = await use.submit({ ...input, idempotencyKey: "key-00000002" });
  expect(use.list().map((command) => command.id).sort()).toEqual([first.command.id, second.command.id].sort());
  expect(use.list("queued")).toEqual([]);
  const all = use.eventsAfter(0);
  expect(all).toHaveLength(6);
  expect(use.eventsAfter(all[3]!.seq).map((event) => event.seq)).toEqual([all[4]!.seq, all[5]!.seq]);
});

test("an answer is recorded under the declared actor, and the decision stands in for an empty reason", async () => {
  const { use, commands } = fixture();
  const { command } = await use.submit(input);
  expect(use.respond(command.id, "accepted", "worker", "").status).toBe("accepted");
  expect(use.report(command.id, "completed", "worker", "tests pass").status).toBe("completed");
  expect(commands.events(command.id).slice(-2).map(({ status, actor, detail }) => ({ status, actor, detail }))).toEqual([
    { status: "accepted", actor: "worker", detail: "accepted" },
    { status: "completed", actor: "worker", detail: "tests pass" },
  ]);
});

test("with an authenticated caller its name replaces every declared actor", async () => {
  const sent: string[] = [];
  const send: Sender = async (session) => { sent.push(session); return { exitCode: 0, stdout: `${session}: delivered`, stderr: "" }; };
  const commands = new Commands(new Store(":memory:").db);
  const use = commandUseCases({ commands, deliverer: new Deliverer(commands, send) }, { name: "token-holder", role: "agent" });
  const { command } = await use.submit({ ...input, actor: "someone-else" });
  expect(command.actor).toBe("token-holder");
  use.respond(command.id, "accepted", "someone-else", "mine");
  use.report(command.id, "failed", "someone-else", "tests fail");
  expect(commands.events(command.id).slice(-2).map(({ status, actor, detail }) => ({ status, actor, detail }))).toEqual([
    { status: "accepted", actor: "token-holder", detail: "mine" },
    { status: "failed", actor: "token-holder", detail: "tests fail" },
  ]);
});

test("reading an unknown command fails the same way the store does", () => {
  const { use } = fixture();
  expect(() => use.read("missing")).toThrow("no command missing");
});
