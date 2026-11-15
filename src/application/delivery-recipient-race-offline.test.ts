import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Commands } from "../data/commands.ts";
import { CommandError } from "../domain/commands.ts";
import { Deliverer } from "./delivery.ts";
import type { SendResult } from "../domain/delivery.ts";

// A send that stays in flight until the test finishes it.
function gated() {
  const db = new Database(":memory:");
  const commands = new Commands(db);
  const id = commands.submit({ idempotencyKey: "race", target: "alpha", actor: "operator", text: "hello" }).command.id;
  let senderStarted!: () => void;
  const started = new Promise<void>((resolve) => { senderStarted = resolve; });
  let finishSender!: (result: SendResult) => void;
  let failSender!: (error: Error) => void;
  const pending = new Promise<SendResult>((resolve, reject) => { finishSender = resolve; failSender = reject; });
  let sends = 0;
  const deliverer = new Deliverer(commands, async (target) => {
    expect(target).toBe("alpha");
    sends++;
    senderStarted();
    return pending;
  }, { mkdtemp: async () => "/fake/delivery", write: async () => {}, rm: async () => {} });
  const statuses = () => commands.events(id).map((event) => event.status);
  return { db, commands, id, deliverer, started, finishSender, failSender, statuses, sends: () => sends };
}

const delivered: SendResult = { exitCode: 0, stdout: "alpha: delivered", stderr: "" };

for (const decision of ["accepted", "rejected"] as const) {
  test(`a recipient's ${decision} during a send stands and the sender's report is kept beside it`, async () => {
    const f = gated();
    const delivery = f.deliverer.deliver(f.id);
    await f.started;
    expect(f.commands.get(f.id).status).toBe("delivering");
    expect(f.commands.transition(f.id, decision, "recipient", "response").status).toBe(decision);
    f.finishSender(delivered);
    expect((await delivery).status).toBe(decision);
    expect(f.commands.get(f.id).status).toBe(decision);
    expect(f.statuses()).toEqual(["queued", "delivering", decision, "delivered"]);
    expect(f.commands.events(f.id).at(-1)).toMatchObject({ actor: "service", detail: "alpha: delivered" });
    // The finished command is not sent again.
    expect((await f.deliverer.deliver(f.id)).status).toBe(decision);
    expect(f.sends()).toBe(1);
    f.db.close();
  });
}

test("an unknown sender result does not replace the recipient's answer", async () => {
  for (const finish of ["result", "exception"] as const) {
    const f = gated();
    const delivery = f.deliverer.deliver(f.id);
    await f.started;
    f.commands.transition(f.id, "accepted", "recipient", "response");
    if (finish === "result") f.finishSender({ exitCode: 7, stdout: "", stderr: "uncertain" });
    else f.failSender(new Error("sender broke"));
    expect((await delivery).status).toBe("accepted");
    expect(f.statuses()).toEqual(["queued", "delivering", "accepted", "delivery_unknown"]);
    expect(f.commands.transition(f.id, "running", "recipient", "started").status).toBe("running");
    f.db.close();
  }
});

test("work reported before the sender returns is not rolled back by the delivery result", async () => {
  const f = gated();
  const delivery = f.deliverer.deliver(f.id);
  await f.started;
  f.commands.transition(f.id, "accepted", "recipient", "response");
  f.commands.transition(f.id, "running", "recipient", "started");
  f.commands.transition(f.id, "completed", "recipient", "done");
  f.finishSender(delivered);
  expect((await delivery).status).toBe("completed");
  expect(f.statuses()).toEqual(["queued", "delivering", "accepted", "running", "completed", "delivered"]);
  f.db.close();
});

test("without an answer the delivery result still sets the status", async () => {
  const f = gated();
  const delivery = f.deliverer.deliver(f.id);
  await f.started;
  for (const status of ["running", "completed", "failed"] as const) {
    expect(() => f.commands.transition(f.id, status, "recipient", "too early")).toThrow(/cannot become/);
  }
  f.finishSender(delivered);
  expect((await delivery).status).toBe("delivered");
  expect(f.commands.transition(f.id, "accepted", "recipient", "response").status).toBe("accepted");
  expect(f.statuses()).toEqual(["queued", "delivering", "delivered", "accepted"]);
  f.db.close();
});

test("a restart during a send keeps the answer and records the unknown outcome once", () => {
  const db = new Database(":memory:");
  const before = new Commands(db);
  const submit = (key: string) => before.submit({ idempotencyKey: key, target: "alpha", actor: "operator", text: key }).command.id;
  const answered = submit("answered");
  const silent = submit("silent");
  const finished = submit("finished");
  const neverSent = submit("never-sent");
  before.transition(answered, "delivering", "service", "send");
  before.transition(answered, "accepted", "recipient", "response");
  before.transition(silent, "delivering", "service", "send");
  before.transition(finished, "delivering", "service", "send");
  before.transition(finished, "accepted", "recipient", "response");
  before.deliveryOutcome(finished, "delivered", "alpha: delivered");
  before.transition(neverSent, "accepted", "recipient", "response");

  const after = new Commands(db);
  expect(after.reconcileAfterRestart().sort()).toEqual([answered, silent].sort());
  expect(after.get(answered).status).toBe("accepted");
  expect(after.events(answered).map((event) => event.status)).toEqual(["queued", "delivering", "accepted", "delivery_unknown"]);
  expect(after.events(answered).at(-1)?.detail).toBe("service restarted during delivery");
  expect(after.get(silent).status).toBe("delivery_unknown");
  expect(after.events(finished).map((event) => event.status)).toEqual(["queued", "delivering", "accepted", "delivered"]);
  expect(after.events(neverSent).map((event) => event.status)).toEqual(["queued", "accepted"]);
  expect(after.reconcileAfterRestart()).toEqual([]);
  db.close();
});

test("a delivery outcome needs a send in progress", () => {
  const db = new Database(":memory:");
  const commands = new Commands(db);
  const id = commands.submit({ idempotencyKey: "outcome", target: "alpha", actor: "operator", text: "hello" }).command.id;
  const refused = () => {
    try { commands.deliveryOutcome(id, "delivered", "alpha: delivered"); } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      return (error as CommandError).kind;
    }
    return "no error";
  };
  expect(refused()).toBe("conflict");
  commands.transition(id, "accepted", "recipient", "response");
  expect(refused()).toBe("conflict");
  expect(commands.events(id).map((event) => event.status)).toEqual(["queued", "accepted"]);

  const sent = commands.submit({ idempotencyKey: "outcome-2", target: "alpha", actor: "operator", text: "hello" }).command.id;
  commands.transition(sent, "delivering", "service", "send");
  commands.transition(sent, "accepted", "recipient", "response");
  expect(commands.deliveryOutcome(sent, "delivered", "alpha: delivered").status).toBe("accepted");
  // One outcome per send.
  expect(() => commands.deliveryOutcome(sent, "delivery_unknown", "late")).toThrow(/no delivery is in progress/);
  expect(() => commands.deliveryOutcome(sent, "delivered", "\ud800")).toThrow();
  expect(commands.events(sent).map((event) => event.status)).toEqual(["queued", "delivering", "accepted", "delivered"]);
  db.close();
});
