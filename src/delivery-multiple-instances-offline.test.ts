import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Commands } from "./data/commands.ts";
import { Deliverer } from "./delivery.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("sender gate timed out")), 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function exercise(twoInstances: boolean) {
  const db = new Database(":memory:");
  const commands = new Commands(db);
  const first = commands.submit({ idempotencyKey: "first", target: "alpha", actor: "operator", text: "first" }).command;
  const second = commands.submit({ idempotencyKey: "second", target: "alpha", actor: "operator", text: "second" }).command;
  const started = [gate(), gate()];
  const finish = [gate(), gate()];
  const calls: { target: string; file: string }[] = [];
  const io = { mkdtemp: async () => "/fake/delivery", write: async () => {}, rm: async () => {} };
  const send = async (target: string, file: string) => {
    const index = calls.length;
    calls.push({ target, file });
    started[index]!.release();
    await finish[index]!.promise;
    return { exitCode: 0, stdout: `${target}: delivered`, stderr: "" };
  };
  const firstDeliverer = new Deliverer(commands, send, io);
  const secondDeliverer = twoInstances ? new Deliverer(commands, send, io) : firstDeliverer;
  const deliveries: Promise<unknown>[] = [];
  try {
    deliveries.push(firstDeliverer.deliver(first.id));
    await bounded(started[0]!.promise);
    deliveries.push(secondDeliverer.deliver(second.id));
    if (twoInstances) {
      await bounded(started[1]!.promise);
      expect(commands.get(first.id).status).toBe("delivering");
      expect(commands.get(second.id).status).toBe("delivering");
    } else {
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toHaveLength(1);
      expect(commands.get(second.id).status).toBe("queued");
      finish[0]!.release();
      await bounded(started[1]!.promise);
      expect(commands.get(first.id).status).toBe("delivered");
      expect(commands.get(second.id).status).toBe("delivering");
    }
    expect(calls.map((call) => call.target)).toEqual(["alpha", "alpha"]);
    expect(calls.map((call) => call.file)).toEqual([`/fake/delivery/${first.id}.txt`, `/fake/delivery/${second.id}.txt`]);
    finish[0]!.release();
    finish[1]!.release();
    await bounded(Promise.all(deliveries));
    expect(commands.get(first.id).status).toBe("delivered");
    expect(commands.get(second.id).status).toBe("delivered");
  } finally {
    for (const item of finish) item.release();
    await Promise.allSettled(deliveries);
    db.close();
  }
}

test("two deliverers overlap sends of distinct commands to the same target", async () => {
  await exercise(true);
});

test("one deliverer serializes sends of distinct commands to the same target", async () => {
  await exercise(false);
});
