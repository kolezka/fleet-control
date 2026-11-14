import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CommandError, Commands } from "./data/commands.ts";
import { Deliverer, type SendResult } from "./delivery.ts";

test("recipient responses conflict until delivery finishes", async () => {
  const db = new Database(":memory:");
  const commands = new Commands(db);
  const id = commands.submit({ idempotencyKey: "race", target: "alpha", actor: "operator", text: "hello" }).command.id;
  let senderStarted!: () => void;
  const started = new Promise<void>((resolve) => { senderStarted = resolve; });
  let finishSender!: (result: SendResult) => void;
  const pending = new Promise<SendResult>((resolve) => { finishSender = resolve; });
  const deliverer = new Deliverer(commands, async (target) => {
    expect(target).toBe("alpha");
    senderStarted();
    return pending;
  }, {
    mkdtemp: async () => "/fake/delivery",
    write: async () => {},
    rm: async () => {},
  });

  const delivery = deliverer.deliver(id);
  await started;
  expect(commands.get(id).status).toBe("delivering");
  for (const decision of ["accepted", "rejected"] as const) {
    try {
      commands.transition(id, decision, "recipient", "response");
      throw new Error("expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).kind).toBe("conflict");
    }
    expect(commands.get(id).status).toBe("delivering");
  }
  expect(commands.events(id).map((event) => event.status)).toEqual(["queued", "delivering"]);
  finishSender({ exitCode: 0, stdout: "alpha: delivered", stderr: "" });
  expect((await delivery).status).toBe("delivered");
  expect(commands.transition(id, "accepted", "recipient", "response").status).toBe("accepted");
  expect(commands.events(id).map((event) => event.status)).toEqual(["queued", "delivering", "delivered", "accepted"]);
  db.close();
});
