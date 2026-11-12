import { expect, test } from "bun:test";
import { HostAgentClient, type HostSocket } from "./client.ts";

class FakeSocket implements HostSocket {
  listeners = new Map<string, (event: any) => void>();
  closed = 0;
  constructor(private failOn?: string) {}
  addEventListener(type: string, listener: (event: any) => void) {
    if (type === this.failOn) throw new Error(`cannot listen for ${type}`);
    this.listeners.set(type, listener);
  }
  emit(type: string, event: any = {}) { this.listeners.get(type)?.(event); }
  send() {}
  close() { this.closed++; }
}

test.each(["open", "close", "error", "message"])("a failure to register the %s listener closes that socket and retries", (type) => {
  const sockets: FakeSocket[] = [], timers: (() => void)[] = [], errors: unknown[] = [];
  const client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret",
    socketFactory: () => { const socket = new FakeSocket(sockets.length === 0 ? type : undefined); sockets.push(socket); return socket; },
    execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
    setTimer: (callback) => { timers.push(callback); return timers.length; }, clearTimer: () => {},
    onError: (error) => errors.push(error) });
  expect(() => client.start()).not.toThrow();
  expect(errors).toHaveLength(1);
  expect(sockets[0]!.closed).toBe(1);
  expect(timers).toHaveLength(1);
  timers[0]!();
  expect(sockets).toHaveLength(2);
  sockets[0]!.emit("open"); sockets[0]!.emit("close"); sockets[0]!.emit("message", { data: "x" });
  expect(timers).toHaveLength(1);
  expect(sockets).toHaveLength(2);
  sockets[1]!.emit("open");
  expect(sockets[1]!.closed).toBe(0);
  client.stop();
});
test("an observer that restarts onto the same socket keeps that connection open", () => {
  let fail = true;
  const socket = new FakeSocket();
  socket.addEventListener = function (type: string, listener: (event: any) => void) {
    if (fail && type === "message") { fail = false; throw new Error("cannot listen"); }
    this.listeners.set(type, listener);
  };
  let client!: HostAgentClient;
  let restarted = false;
  client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret",
    socketFactory: () => socket,
    execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
    setTimer: () => 1, clearTimer: () => {},
    onError: () => { if (!restarted) { restarted = true; client.stop(); client.start(); } } });
  client.start();
  expect(socket.closed).toBe(0);
  expect(() => client.sendInventory(["ok"])).not.toThrow();
  client.stop();
  expect(socket.closed).toBe(1);
});
