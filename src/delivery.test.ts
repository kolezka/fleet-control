import { resolveFleetBin } from "./fleet/path.ts";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Commands } from "./data/commands.ts";
import { classify, Deliverer, fleetSender, type Sender } from "./delivery.ts";
import { createTestFleet, type TestFleet } from "./fleet/fixture.ts";

const fleetBin = resolveFleetBin();
let fleet: TestFleet;
beforeAll(async () => { fleet = await createTestFleet(fleetBin); });
afterAll(async () => { await fleet?.cleanup(); });

const submit = (c: Commands, key: string, target: string, text = "check the build") =>
  c.submit({ idempotencyKey: key, target, actor: "test", text }).command.id;

test("classify: exact target confirmation is delivered; unconfirmed results are unknown", () => {
  expect(classify({ exitCode: 0, stdout: "s: delivered", stderr: "" }, "s").status).toBe("delivered");
  expect(classify({ exitCode: 0, stdout: "", stderr: "" }, "s").status).toBe("delivery_unknown");
  expect(classify({ exitCode: 6, stdout: "", stderr: "s: message file x is empty or blank, not sent" }, "s").status).toBe("delivery_unknown");
  expect(classify({ exitCode: 5, stdout: "", stderr: "s: pasted but first line not found in pane" }, "s").status).toBe("delivery_unknown");
  expect(classify({ exitCode: 2, stdout: "", stderr: "no session s" }, "s").status).toBe("delivery_unknown");
  expect(classify({ exitCode: 3, stdout: "", stderr: "s: a dialog opened during the paste, Enter not pressed." }, "s").status).toBe("delivery_unknown");
});

test("real fleet send puts the command id in the pane and records delivered", async () => {
  const commands = new Commands(new Database(":memory:"));
  const deliverer = new Deliverer(commands, fleetSender(fleetBin, fleet.confPath));
  const id = submit(commands, "deliver-1", fleet.session);
  const after = await deliverer.deliver(id);
  expect(after.status).toBe("delivered");
  const pane = (await fleet.tmux("capture-pane", "-p", "-J", "-S", "-200", "-t", fleet.session)).stdout;
  expect(pane).toContain(`Fleet Control command ${id}`);
  expect(commands.events(id).map((e) => e.status)).toEqual(["queued", "delivering", "delivered"]);
  // delivering again is a no-op: a delivered command is never pasted twice
  expect((await deliverer.deliver(id)).status).toBe("delivered");
  expect(commands.events(id)).toHaveLength(3);
});

test("real fleet send to a missing session leaves the command unknown", async () => {
  const commands = new Commands(new Database(":memory:"));
  const deliverer = new Deliverer(commands, fleetSender(fleetBin, fleet.confPath));
  const id = submit(commands, "deliver-2", "no-such-session");
  const after = await deliverer.deliver(id);
  expect(after.status).toBe("delivery_unknown");
  expect(commands.events(id).at(-1)?.detail).toBe("fleet send result unknown");
});

test("real fleet send refuses dialog-like text; the command is unknown", async () => {
  const commands = new Commands(new Database(":memory:"));
  const deliverer = new Deliverer(commands, fleetSender(fleetBin, fleet.confPath));
  const id = submit(commands, "deliver-3", fleet.session, "Do you want to proceed?");
  expect((await deliverer.deliver(id)).status).toBe("delivery_unknown");
  expect(commands.events(id).at(-1)?.detail).toBe("fleet send result unknown");
});

test("deliveries are serialized", async () => {
  const commands = new Commands(new Database(":memory:"));
  let active = 0;
  let peak = 0;
  const slow: Sender = async (s) => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(30);
    active--;
    return { exitCode: 0, stdout: `${s}: delivered`, stderr: "" };
  };
  const deliverer = new Deliverer(commands, slow);
  const ids = ["a", "b", "c"].map((k) => submit(commands, `serial-${k}`, "x"));
  const results = await Promise.all(ids.map((id) => deliverer.deliver(id)));
  expect(results.map((r) => r.status)).toEqual(["delivered", "delivered", "delivered"]);
  expect(peak).toBe(1);
});

test("a sender that throws leaves the command delivery_unknown, not delivering", async () => {
  const commands = new Commands(new Database(":memory:"));
  const deliverer = new Deliverer(commands, async () => { throw new Error("spawn failed"); });
  const id = submit(commands, "throw-1", "x");
  expect((await deliverer.deliver(id)).status).toBe("delivery_unknown");
});
