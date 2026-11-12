import { expect, test } from "bun:test";
import { HostAgentClient, type HostSocket } from "./client.ts";

class FakeSocket implements HostSocket {
  listeners = new Map<string, (event: any) => void>();
  closed = 0;
  onClose = () => {};
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, listener); }
  emit(type: string, event: any = {}) { this.listeners.get(type)?.(event); }
  send() {}
  close() { this.closed++; this.onClose(); }
}

test("stop detaches the timer before clearTimer can start a replacement", () => {
  const sockets: FakeSocket[] = [], timers: (() => void)[] = [], cleared: unknown[] = [];
  let client!: HostAgentClient;
  client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret",
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
    setTimer: (callback) => { timers.push(callback); return callback; },
    clearTimer: (timer) => { cleared.push(timer); if (cleared.length === 1) { client.start(); sockets[1]!.emit("close"); } } });
  client.start(); sockets[0]!.emit("close");
  client.stop();
  expect(timers).toHaveLength(2);
  client.stop();
  expect(cleared).toEqual([timers[0], timers[1]]);
});

test("stop closes only the detached socket when close reenters start", () => {
  const sockets: FakeSocket[] = [];
  const client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret",
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
    setTimer: (callback) => callback, clearTimer: () => {} });
  client.start(); sockets[0]!.onClose = () => client.start();
  client.stop();
  expect(sockets).toHaveLength(2);
  expect(sockets[0]!.closed).toBe(1);
  expect(sockets[1]!.closed).toBe(0);
  client.sendInventory(["fresh"]);
  client.stop();
  expect(sockets[1]!.closed).toBe(1);
});

test("stop propagates clearTimer errors", () => {
  const error = new Error("clear failed"), socket = new FakeSocket();
  const client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret",
    socketFactory: () => socket, execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
    setTimer: (callback) => callback, clearTimer: () => { throw error; } });
  client.start(); socket.emit("close");
  expect(() => client.stop()).toThrow(error);
});

test("stop propagates close errors", () => {
  const error = new Error("close failed");
  const socket = new FakeSocket(); socket.onClose = () => { throw error; };
  const client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret",
    socketFactory: () => socket, execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
    setTimer: (callback) => callback, clearTimer: () => {} });
  client.start();
  expect(() => client.stop()).toThrow(error);
  expect(socket.closed).toBe(1);
});
