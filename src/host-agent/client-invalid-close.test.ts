import { expect, test } from "bun:test";
import { HostAgentClient, type HostSocket } from "./client.ts";

class ThrowingCloseSocket implements HostSocket {
  listeners = new Map<string, ((event: any) => void)[]>();
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send() {}
  close() { throw new Error("close failed"); }
}

// Rejecting an invalid dispatch drops the socket. If close throws, the client must still schedule
// a reconnect instead of going silent with no socket and no timer.
test("an invalid dispatch still schedules a reconnect when socket.close throws", () => {
  const sockets: ThrowingCloseSocket[] = [];
  const timers: (() => void)[] = [];
  const client = new HostAgentClient({
    url: "wss://central.example/agent", hostId: "h", token: "secret-token",
    socketFactory: () => { const socket = new ThrowingCloseSocket(); sockets.push(socket); return socket; },
    execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
    onError: () => {},
    setTimer: (callback) => { timers.push(callback); return {}; }, clearTimer: () => {},
  });
  client.start();
  sockets[0]!.emit("open");
  expect(() => sockets[0]!.emit("message", { data: "not json" })).not.toThrow();
  expect(timers.length).toBe(1);
  timers[0]!();
  expect(sockets.length).toBe(2);
});
