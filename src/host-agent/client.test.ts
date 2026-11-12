import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DeliveryJournal } from "./journal.ts";
import { HostAgentClient, type HostClientOptions, type HostSocket } from "./client.ts";

class FakeSocket implements HostSocket {
  listeners = new Map<string, ((event: any) => void)[]>();
  sent: string[] = [];
  closed: [number | undefined, string | undefined][] = [];
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send(value: string) { this.sent.push(value); }
  close(code?: number, reason?: string) { this.closed.push([code, reason]); }
}
const dispatch = { version: 1, type: "dispatch", hostId: "h", commandId: "command", attemptId: "attempt", target: "supervisor", text: "hello" } as const;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup(overrides: Partial<HostClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  const calls: unknown[] = [];
  const options: HostClientOptions = {
    url: "wss://central.example/agent", hostId: "h", token: "secret",
    socketFactory: (url, config) => { calls.push([url, config]); const socket = new FakeSocket(); sockets.push(socket); return socket; },
    execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer as typeof timers[number]); if (index >= 0) timers.splice(index, 1); },
    ...overrides,
  };
  return { client: new HostAgentClient(options), sockets, timers, calls, options };
}

test("requires secure URLs, prevents URL credentials and sends bearer header", () => {
  for (const url of ["ws://example.com", "ws://127.0.0.1", "wss://user:secret@example.com", "wss://example.com/?token=secret", "wss://example.com/secret", "https://example.com"]) {
    expect(() => setup({ url })).toThrow();
  }
  expect(() => setup({ url: "ws://127.0.0.1/test", allowLoopbackWsForTests: true })).not.toThrow();
  expect(() => setup({ url: "ws://example.com", allowLoopbackWsForTests: true })).toThrow();
  const { client, calls } = setup(); client.start();
  expect(calls).toEqual([["wss://central.example/agent", { headers: { Authorization: "Bearer secret" } }]]);
});

test("validates bounded protocol and never executes unrecognized frames", async () => {
  const invalid = [JSON.stringify({ ...dispatch, hostId: "wrong" }), JSON.stringify({ ...dispatch, version: 2 }), JSON.stringify({ ...dispatch, type: "shell" }), JSON.stringify({ ...dispatch, command: "rm" }), JSON.stringify({ ...dispatch, attemptId: "a\ud800" }), JSON.stringify({ ...dispatch, text: "\udc00" }), "x".repeat(65537), new Uint8Array([1])];
  for (const data of invalid) {
    let executed = false;
    const { client, sockets } = setup({ execute: async () => { executed = true; return { id: "attempt", status: "delivered" }; } });
    client.start(); sockets[0]!.emit("message", { data }); await flush();
    expect(executed).toBe(false); expect(sockets[0]!.closed.length).toBe(1);
  }
});

test("dispatches sequentially and returns journaled attempt outcomes with distinct identities", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  const { client, sockets } = setup({ execute: async (item) => { seen.push(item.attemptId); if (item.attemptId === "attempt") await gate; return { id: item.attemptId, status: item.attemptId === "attempt" ? "delivered" : "started" }; } });
  client.start(); const socket = sockets[0]!;
  socket.emit("message", { data: JSON.stringify(dispatch) });
  socket.emit("message", { data: JSON.stringify({ ...dispatch, attemptId: "second" }) });
  await flush(); expect(seen).toEqual(["attempt"]);
  release(); await flush();
  expect(seen).toEqual(["attempt", "second"]);
  expect(socket.sent.map((s) => JSON.parse(s))).toEqual([
    { version: 1, type: "receipt", hostId: "h", commandId: "command", attemptId: "attempt", status: "delivered" },
    { version: 1, type: "receipt", hostId: "h", commandId: "command", attemptId: "second", status: "unknown" },
  ]);
  client.sendInventory(["supervisor"]); expect(JSON.parse(socket.sent[2]!).type).toBe("inventory");
});

test("republishes fresh inventory on reconnect and ignores stale asynchronous results", async () => {
  let resolveFirst!: (sessions: string[]) => void;
  let calls = 0;
  const { client, sockets, timers } = setup({ inventory: () => ++calls === 1 ? new Promise((resolve) => { resolveFirst = resolve; }) : ["fresh"] });
  client.start(); sockets[0]!.emit("open"); await flush();
  sockets[0]!.emit("close"); timers.shift()!.callback(); sockets[1]!.emit("open");
  await flush(); resolveFirst(["stale"]); await flush();
  expect(sockets[0]!.sent).toEqual([]);
  expect(sockets[1]!.sent.map((raw) => JSON.parse(raw).sessions)).toEqual([["fresh"]]);
  client.stop();
});

test("duplicate attempt is never replayed and new attempt is distinct", async () => {
  const db = new Database(":memory:");
  const journal = new DeliveryJournal(db);
  let executions = 0;
  const { client, sockets } = setup({ execute: async (item) => {
    const started = journal.start(item.attemptId, JSON.stringify([item.commandId, item.hostId, item.target, item.text]));
    if (!started.authorized) return started.attempt;
    executions++;
    return journal.finish(item.attemptId, "delivered");
  } });
  client.start(); const socket = sockets[0]!;
  for (const attemptId of ["attempt", "attempt", "second"]) socket.emit("message", { data: JSON.stringify({ ...dispatch, attemptId }) });
  await flush();
  expect(executions).toBe(2);
  expect(journal.get("command")).toBeNull();
  expect(socket.sent.map((s) => JSON.parse(s).attemptId)).toEqual(["attempt", "attempt", "second"]);
  db.close();
});

test("reconnects with bounded backoff and does not replay disconnected work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  const { client, sockets, timers } = setup({ execute: async (item) => { seen.push(item.attemptId); await gate; return { id: item.attemptId, status: "delivered" }; } });
  client.start(); const first = sockets[0]!;
  first.emit("message", { data: JSON.stringify(dispatch) });
  first.emit("message", { data: JSON.stringify({ ...dispatch, attemptId: "queued" }) });
  await flush(); first.emit("close");
  expect(timers[0]!.delay).toBe(1000); timers.shift()!.callback();
  release(); await flush(); expect(seen).toEqual(["attempt"]); expect(sockets[1]!.sent).toEqual([]);
  for (const expected of [2000, 5000, 10000, 30000, 30000]) { sockets.at(-1)!.emit("close"); expect(timers[0]!.delay).toBe(expected); timers.shift()!.callback(); }
  sockets.at(-1)!.emit("open"); sockets.at(-1)!.emit("close"); expect(timers[0]!.delay).toBe(1000);
  client.stop(); expect(timers.length).toBe(0);
});
