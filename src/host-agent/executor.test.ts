import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DeliveryJournal, JournalError } from "./data/journal.ts";
import { DeliveryExecutor, type CommandOffer } from "./executor.ts";

const offer: CommandOffer = { id: "cmd-1", hostId: "host-1", target: "supervisor", text: "hello", instanceId: "instance-1" };
const confirmed = { exitCode: 0, stdout: "supervisor: delivered", stderr: "" };

function setup(send: (offer: CommandOffer) => Promise<typeof confirmed>, lookup = async (_target: string) => "instance-1") {
  const db = new Database(":memory:");
  const journal = new DeliveryJournal(db);
  return { journal, executor: new DeliveryExecutor(journal, "host-1", lookup, send) };
}

describe("host delivery executor", () => {
  test("rejects host and runtime mismatches before journal or sender", async () => {
    let sends = 0;
    let lookups = 0;
    const { executor, journal } = setup(async () => { sends++; return confirmed; }, async () => { lookups++; return "other"; });
    await expect(executor.execute({ ...offer, hostId: "other" })).rejects.toThrow();
    expect(lookups).toBe(0);
    await expect(executor.execute(offer)).rejects.toThrow();
    expect(journal.get(offer.id)).toBeNull();
    expect(sends).toBe(0);
  });

  test("records before send and executes an intent only once, even concurrently", async () => {
    let sends = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const { executor, journal } = setup(async () => {
      sends++;
      expect(journal.get(offer.id)?.status).toBe("started");
      await wait;
      return confirmed;
    });
    const first = executor.execute(offer);
    await Promise.resolve();
    await Promise.resolve();
    const duplicate = executor.execute(offer);
    release();
    expect((await first).status).toBe("delivered");
    expect((await duplicate).status).toBe("delivered");
    expect((await executor.execute(offer)).status).toBe("delivered");
    expect(sends).toBe(1);
    await expect(executor.execute({ ...offer, text: "changed" })).rejects.toBeInstanceOf(JournalError);
    expect(sends).toBe(1);
  });

  test("serializes different offers and checks runtime only when their turn begins", async () => {
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const calls: string[] = [];
    let instance = "instance-1";
    const { executor } = setup(async (item) => {
      calls.push(`send:${item.id}`);
      if (item.id === offer.id) { started(); await wait; }
      return confirmed;
    }, async () => { calls.push(`lookup:${instance}`); return instance; });
    const first = executor.execute(offer);
    await firstStarted;
    const second = executor.execute({ ...offer, id: "cmd-2" });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["lookup:instance-1", "send:cmd-1"]);
    instance = "instance-2";
    release();
    expect((await first).status).toBe("delivered");
    await expect(second).rejects.toThrow("offer runtime instance does not match local target");
    instance = "instance-1";
    expect((await executor.execute({ ...offer, id: "cmd-3" })).status).toBe("delivered");
    expect(calls).toEqual(["lookup:instance-1", "send:cmd-1", "lookup:instance-2", "lookup:instance-1", "send:cmd-3"]);
  });

  test("ambiguous responses and exceptions become unknown and are never retried", async () => {
    for (const response of [async () => ({ exitCode: 1, stdout: "", stderr: "not sent" }), async () => { throw new Error("disconnected"); }, async () => ({ exitCode: 0, stdout: "", stderr: "" })]) {
      let sends = 0;
      const { executor } = setup(async () => { sends++; return response(); });
      expect((await executor.execute(offer)).status).toBe("unknown");
      expect((await executor.execute(offer)).status).toBe("unknown");
      expect(sends).toBe(1);
    }
  });

  test("replays stored outcomes and rejects conflicts without consulting a replaced runtime", async () => {
    for (const status of ["delivered", "unknown"] as const) {
      let runtime = "instance-1";
      let lookups = 0;
      let sends = 0;
      const { executor } = setup(async () => { sends++; return status === "delivered" ? confirmed : { exitCode: 1, stdout: "", stderr: "" }; }, async () => { lookups++; return runtime; });
      expect((await executor.execute(offer)).status).toBe(status);
      runtime = "instance-2";
      expect((await executor.execute(offer)).status).toBe(status);
      await expect(executor.execute({ ...offer, text: "different" })).rejects.toBeInstanceOf(JournalError);
      expect(lookups).toBe(1);
      expect(sends).toBe(1);
    }
  });

  test("does not resend an already started attempt after runtime replacement", async () => {
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const sending = new Promise<void>((resolve) => { started = resolve; });
    let sends = 0;
    const { executor, journal } = setup(async () => { sends++; started(); await wait; return confirmed; });
    const first = executor.execute(offer);
    await sending;
    const other = new DeliveryExecutor(journal, "host-1", async () => { throw new Error("must not look up"); }, async () => { sends++; return confirmed; });
    expect((await other.execute(offer)).status).toBe("started");
    await expect(other.execute({ ...offer, instanceId: "instance-2" })).rejects.toBeInstanceOf(JournalError);
    release();
    expect((await first).status).toBe("delivered");
    expect(sends).toBe(1);
  });

  test("returns a concurrent journal entry when runtime changes during lookup", async () => {
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const lookupStarted = new Promise<void>((resolve) => { entered = resolve; });
    let sends = 0;
    const { executor, journal } = setup(async () => { sends++; return confirmed; }, async () => { entered(); await wait; return "instance-2"; });
    const competing = new DeliveryExecutor(journal, "host-1", async () => "instance-1", async () => { sends++; return confirmed; });
    const pending = executor.execute(offer);
    await lookupStarted;
    expect((await competing.execute(offer)).status).toBe("delivered");
    release();
    expect((await pending).status).toBe("delivered");
    expect(sends).toBe(1);
  });

  test("copies offered intent before asynchronous lookup", async () => {
    const input = { ...offer };
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let sent: CommandOffer | undefined;
    const { executor } = setup(async (item) => { sent = item; return confirmed; }, async () => { await wait; return "instance-1"; });
    const running = executor.execute(input);
    input.text = "mutated";
    release();
    await running;
    expect(sent?.text).toBe("hello");
  });
});
