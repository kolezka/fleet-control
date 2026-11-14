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

test("reading an unknown command fails the same way the store does", () => {
  const { use } = fixture();
  expect(() => use.read("missing")).toThrow("no command missing");
});
