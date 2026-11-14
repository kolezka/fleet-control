import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DeliveryExecutor, type CommandOffer } from "./executor.ts";
import { DeliveryJournal } from "../data/journal.ts";

test("unintegrated hypothetical name-based fake sender can deliver to a replacement after lookup", async () => {
  const db = new Database(":memory:");
  const journal = new DeliveryJournal(db);
  const offer: CommandOffer = { id: "attempt-1", hostId: "host-1", target: "supervisor", text: "hello", instanceId: "original" };
  let runtime = "original";
  const lookups: string[] = [];
  const recipients: string[] = [];
  let entered!: () => void;
  let release!: () => void;
  const senderEntered = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const executor = new DeliveryExecutor(journal, "host-1", async (target) => {
    expect(target).toBe(offer.target);
    lookups.push(runtime);
    return runtime;
  }, async (item) => {
    entered();
    await gate;
    // This fake resolves by name at send time; it is not an integrated fleet sender.
    if (item.target === offer.target) recipients.push(runtime);
    return { exitCode: 0, stdout: "supervisor: delivered", stderr: "" };
  });
  const pending = executor.execute(offer);
  try {
    await senderEntered;
    expect(lookups).toEqual(["original"]);
    expect(journal.get(offer.id)?.status).toBe("started");
    expect(recipients).toEqual([]);
    runtime = "replacement";
    release();
    expect((await pending).status).toBe("delivered");
    expect(recipients).toEqual(["replacement"]);
    expect(journal.get(offer.id)?.status).toBe("delivered");
    expect(lookups).toEqual(["original"]);
  } finally {
    release();
    await Promise.allSettled([pending]);
    db.close();
  }
});
