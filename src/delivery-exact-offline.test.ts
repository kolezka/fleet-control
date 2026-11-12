import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { classify, Deliverer, fleetSender } from "./delivery.ts";
import { Commands } from "./commands.ts";
import { DeliveryJournal } from "./host-agent/journal.ts";
import { DeliveryExecutor } from "./host-agent/executor.ts";

test("exact target response is required", () => {
  for (const stdout of ["alpha: delivered", "alpha: delivered\n", "alpha: delivered\r\n"]) {
    expect(classify({ exitCode: 0, stdout, stderr: "" }, "alpha").status).toBe("delivered");
  }
  for (const stdout of ["delivered", "beta: delivered", "alpha: delivered twice", " alpha: delivered", "alpha: delivered\n\n", "alpha: delivered\r", "alpha: delivered\nextra"]) {
    expect(classify({ exitCode: 0, stdout, stderr: "" }, "alpha").status).toBe("delivery_unknown");
  }
  expect(classify({ exitCode: 1, stdout: "alpha: delivered", stderr: "" }, "alpha").status).toBe("delivery_unknown");
});

test("deliverer and executor compare the intended target", async () => {
  const commands = new Commands(new Database(":memory:"));
  const id = commands.submit({ idempotencyKey: "one", target: "alpha", actor: "test", text: "hello" }).command.id;
  const result = { exitCode: 0, stdout: "beta: delivered", stderr: "" };
  const deliverer = new Deliverer(commands, async () => result);
  expect((await deliverer.deliver(id)).status).toBe("delivery_unknown");
  const journal = new DeliveryJournal(new Database(":memory:"));
  const executor = new DeliveryExecutor(journal, "host", async () => "instance", async () => result);
  expect((await executor.execute({ id: "one", hostId: "host", target: "alpha", text: "hello", instanceId: "instance" })).status).toBe("unknown");
});

test("sender preserves raw stdout", async () => {
  const send = fleetSender("/bin/echo", "unused");
  const result = await send("alpha", "unused");
  expect(result.stdout).toBe("send alpha unused\n");
});