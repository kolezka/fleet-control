import { expect, test } from "bun:test";
import { HostAgentClient, type HostSocket } from "./client.ts";

class FakeSocket implements HostSocket {
  listeners = new Map<string, (event: any) => void>();
  closed = 0;
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, listener); }
  emit(type: string, event: any = {}) { this.listeners.get(type)?.(event); }
  send() {}
  close() { this.closed++; }
}

function setup(clearTimer: (timer: unknown) => void) {
  const sockets: FakeSocket[] = [], timers: (() => void)[] = [];
  const client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret",
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
    setTimer: (callback) => { timers.push(callback); return timers.length; }, clearTimer });
  return { client, sockets, timers };
}

test("a timer that clearTimer failed to cancel cannot reconnect a stopped client", () => {
  const error = new Error("clear failed");
  const { client, sockets, timers } = setup(() => { throw error; });
  client.start(); sockets[0]!.emit("close");
  expect(() => client.stop()).toThrow(error);
  timers[0]!();
  expect(sockets).toHaveLength(1);
});

test("a timer that clearTimer failed to cancel cannot steal a restarted client's retry", () => {
  let fail = true;
  const { client, sockets, timers } = setup(() => { if (fail) throw new Error("clear failed"); });
  client.start(); sockets[0]!.emit("close");
  expect(() => client.stop()).toThrow();
  fail = false;
  client.start(); sockets[1]!.emit("close");
  expect(timers).toHaveLength(2);
  timers[0]!();
  expect(sockets).toHaveLength(2);
  timers[1]!();
  expect(sockets).toHaveLength(3);
});

test("a timer callback that runs inside setTimer does not leave a dead handle blocking later retries", () => {
  const sockets: FakeSocket[] = [];
  let handles = 0;
  const client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret",
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
    setTimer: (callback) => { callback(); return ++handles; }, clearTimer: () => {} });
  client.start(); sockets[0]!.emit("close");
  expect(sockets).toHaveLength(2);
  sockets[1]!.emit("close");
  expect(sockets).toHaveLength(3);
});
