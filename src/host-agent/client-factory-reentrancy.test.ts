import { expect, test } from "bun:test";
import { HostAgentClient, type HostSocket } from "./client.ts";

class Socket implements HostSocket {
  listeners = new Map<string, ((event: any) => void)[]>();
  sent: string[] = [];
  closed = 0;
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send(raw: string) { this.sent.push(raw); }
  close() { this.closed++; }
}
const dispatch = JSON.stringify({ version: 1, type: "dispatch", hostId: "h", commandId: "c", attemptId: "a", target: "s", text: "hello" });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(factory: () => HostSocket, onError?: (error: unknown) => void) {
  const timers: { callback: () => void; delay: number }[] = [];
  const errors: unknown[] = [];
  let executions = 0;
  const client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret", socketFactory: factory,
    execute: async (item) => { executions++; return { id: item.attemptId, status: "delivered" }; },
    onError: (error) => { errors.push(error); onError?.(error); },
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer as typeof timers[number]); if (index >= 0) timers.splice(index, 1); },
  });
  return { client, timers, errors, executions: () => executions };
}

test("nested restart keeps the newer owner even when factory returns the same socket", async () => {
  const socket = new Socket(); let calls = 0; let client!: HostAgentClient;
  const fixture = setup(() => { if (++calls === 1) { client.stop(); client.start(); } return socket; }); client = fixture.client;
  client.start();
  expect(socket.closed).toBe(0); expect(socket.listeners.get("message")).toHaveLength(1);
  socket.emit("message", { data: dispatch }); await flush();
  expect(fixture.executions()).toBe(1); expect(socket.sent).toHaveLength(1);
  client.stop(); expect(socket.closed).toBe(1);
});

test("factory return after stop is closed, not installed", () => {
  const socket = new Socket(); let client!: HostAgentClient;
  const fixture = setup(() => { client.stop(); return socket; }); client = fixture.client;
  client.start(); expect(socket.closed).toBe(1); expect(socket.listeners.size).toBe(0);
  expect(() => client.sendInventory([])).toThrow("not connected"); expect(fixture.timers).toHaveLength(0);
});

test("stale factory throw is reported without scheduling against a restarted client", () => {
  const socket = new Socket(); const error = new Error("factory failed"); let calls = 0; let client!: HostAgentClient;
  const fixture = setup(() => { if (++calls === 1) { client.stop(); client.start(); throw error; } return socket; }); client = fixture.client;
  client.start(); expect(fixture.errors).toEqual([error]); expect(fixture.timers).toHaveLength(0);
  client.sendInventory([]); expect(socket.sent).toHaveLength(1); client.stop();
});

test("error observer restart does not schedule the failed attempt", () => {
  const socket = new Socket(); const error = new Error("factory failed"); let calls = 0; let client!: HostAgentClient;
  const fixture = setup(() => { if (++calls === 1) throw error; return socket; }, () => { client.stop(); client.start(); }); client = fixture.client;
  client.start(); expect(fixture.errors).toEqual([error]); expect(fixture.timers).toHaveLength(0);
  client.sendInventory([]); expect(socket.sent).toHaveLength(1); client.stop();
});

test("ordinary factory failure reports and schedules a retry", () => {
  const socket = new Socket(); const error = new Error("factory failed"); let calls = 0;
  const fixture = setup(() => { if (++calls === 1) throw error; return socket; });
  fixture.client.start(); expect(fixture.errors).toEqual([error]); expect(fixture.timers.map((timer) => timer.delay)).toEqual([1000]);
  fixture.timers[0]!.callback(); fixture.client.sendInventory([]); expect(socket.sent).toHaveLength(1); fixture.client.stop();
});

test("superseded attempt closes its own different socket and leaves the newer one live", async () => {
  const outer = new Socket(); const inner = new Socket(); let calls = 0; let client!: HostAgentClient;
  const fixture = setup(() => { if (++calls === 1) { client.stop(); client.start(); return outer; } return inner; }); client = fixture.client;
  client.start();
  expect(outer.closed).toBe(1); expect(outer.listeners.size).toBe(0);
  expect(inner.closed).toBe(0); expect(inner.listeners.get("message")).toHaveLength(1);
  client.sendInventory([]); expect(inner.sent).toHaveLength(1); expect(outer.sent).toHaveLength(0);
  expect(fixture.timers).toHaveLength(0);
  client.stop();
});

test("throwing orphan close is reported and does not escape start", () => {
  const socket = new Socket(); const error = new Error("close failed"); let client!: HostAgentClient;
  socket.close = () => { throw error; };
  const fixture = setup(() => { client.stop(); return socket; }, () => { throw new Error("observer failed"); }); client = fixture.client;
  expect(() => client.start()).not.toThrow();
  expect(fixture.errors).toEqual([error]); expect(fixture.timers).toHaveLength(0);
});
