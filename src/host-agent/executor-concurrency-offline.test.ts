import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DeliveryExecutor, type CommandOffer } from "./executor.ts";
import { DeliveryJournal, type DeliveryAttempt } from "./data/journal.ts";

const offer: CommandOffer = { id: "first", hostId: "host-1", target: "supervisor", text: "hello", instanceId: "instance-1" };
const confirmed = { exitCode: 0, stdout: "supervisor: delivered", stderr: "" };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function within(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("sender did not enter")), 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

test("separate executor queues allow overlapping sends with one shared journal", async () => {
  const db = new Database(":memory:");
  const journal = new DeliveryJournal(db);
  const release = gate();
  const firstEntered = gate();
  const secondEntered = gate();
  const entered: string[] = [];
  const send = async (item: CommandOffer) => {
    entered.push(item.id);
    if (item.id === "first") firstEntered.release();
    else secondEntered.release();
    await release.promise;
    return confirmed;
  };
  const firstExecutor = new DeliveryExecutor(journal, "host-1", async () => "instance-1", send);
  const secondExecutor = new DeliveryExecutor(journal, "host-1", async () => "instance-1", send);
  const pending: Promise<DeliveryAttempt>[] = [];
  try {
    pending.push(firstExecutor.execute(offer));
    await within(firstEntered.promise);
    pending.push(secondExecutor.execute({ ...offer, id: "second" }));
    await within(secondEntered.promise);
    expect(entered).toEqual(["first", "second"]);
    expect(journal.get("first")?.status).toBe("started");
    expect(journal.get("second")?.status).toBe("started");
    release.release();
    expect((await Promise.all(pending)).map((item) => item.status)).toEqual(["delivered", "delivered"]);
  } finally {
    release.release();
    await Promise.allSettled(pending);
    db.close();
  }
});

test("one executor serializes sends for different IDs", async () => {
  const db = new Database(":memory:");
  const journal = new DeliveryJournal(db);
  const release = gate();
  const firstEntered = gate();
  const events: string[] = [];
  const executor = new DeliveryExecutor(journal, "host-1", async () => "instance-1", async (item) => {
    events.push("start:" + item.id);
    if (item.id === "first") {
      firstEntered.release();
      await release.promise;
    }
    events.push("end:" + item.id);
    return confirmed;
  });
  const pending: Promise<DeliveryAttempt>[] = [];
  try {
    pending.push(executor.execute(offer));
    await within(firstEntered.promise);
    pending.push(executor.execute({ ...offer, id: "second" }));
    await Promise.resolve();
    expect(events).toEqual(["start:first"]);
    expect(journal.get("second")).toBeNull();
    release.release();
    expect((await Promise.all(pending)).map((item) => item.status)).toEqual(["delivered", "delivered"]);
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  } finally {
    release.release();
    await Promise.allSettled(pending);
    db.close();
  }
});
