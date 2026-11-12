import { expect, test } from "bun:test";
import { HostAgentClient, type HostSocket } from "./client.ts";

class Socket implements HostSocket {
  listeners = new Map<string, ((event: any) => void)[]>();
  sent: string[] = [];
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send(raw: string) { this.sent.push(raw); }
  close() {}
}
const dispatch = JSON.stringify({ version: 1, type: "dispatch", hostId: "h", commandId: "c", attemptId: "a", target: "s", text: "hello" });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(execute: (item: any) => Promise<any>, onError?: (error: unknown) => void) {
  const socket = new Socket();
  let timer!: () => void;
  const client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret", socketFactory: () => socket, execute, onError, setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => {} });
  client.start();
  return { client, socket, reconnect: () => { socket.emit("close"); timer(); } };
}
test("reused socket runs only the current listener", async () => {
  let calls = 0;
  const { socket, reconnect } = setup(async (item) => { calls++; return { id: item.attemptId, status: "delivered" }; });
  reconnect(); socket.emit("message", { data: dispatch }); await flush();
  expect(calls).toBe(1); expect(socket.sent.length).toBe(1);
});
test("in-flight receipt is not forwarded on reused socket", async () => {
  let release!: (value: any) => void;
  const { socket, reconnect } = setup(() => new Promise((resolve) => { release = resolve; }));
  socket.emit("message", { data: dispatch }); await flush(); reconnect();
  release({ id: "a", status: "delivered" }); await flush();
  expect(socket.sent).toEqual([]);
});
test("invalid in-flight journal outcomes are reported after disconnect without a receipt", async () => {
  for (const outcome of [{ id: "wrong", status: "delivered" }, { id: "a", status: "invalid" }]) {
    let release!: (value: any) => void;
    const errors: unknown[] = [];
    const { client, socket } = setup(() => new Promise((resolve) => { release = resolve; }), (error) => errors.push(error));
    socket.emit("message", { data: dispatch }); await flush();
    socket.emit("close");
    release(outcome); await flush();
    expect(socket.sent).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new Error("invalid journal outcome"));
    client.stop();
  }
});
test("queued old work does not execute after socket reuse", async () => {
  let release!: (value: any) => void; const calls: string[] = []; const errors: unknown[] = [];
  const { socket, reconnect } = setup((item) => {
    calls.push(item.attemptId);
    return item.attemptId === "a" ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ id: item.attemptId, status: "delivered" });
  }, (error) => errors.push(error));
  socket.emit("message", { data: dispatch }); socket.emit("message", { data: dispatch }); await flush(); reconnect();
  release({ id: "a", status: "delivered" }); await flush();
  expect(calls).toEqual(["a"]); expect(socket.sent).toEqual([]);
  socket.emit("message", { data: JSON.stringify({ ...JSON.parse(dispatch), attemptId: "fresh" }) }); await flush();
  expect(calls).toEqual(["a", "fresh"]);
  expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([{ version: 1, type: "receipt", hostId: "h", commandId: "c", attemptId: "fresh", status: "delivered" }]);
  expect(errors).toEqual([]);
});
test("receipt serialization cannot forward across a reentrant reconnect", async () => {
  const errors: unknown[] = []; let hooks = 0;
  const { socket, reconnect } = setup(async (item) => ({ id: item.attemptId, status: "delivered" }), (error) => errors.push(error));
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value() { if (this.type === "receipt") { hooks++; reconnect(); } return this; } });
  try { socket.emit("message", { data: dispatch }); await flush(); }
  finally { if (original) Object.defineProperty(Object.prototype, "toJSON", original); else Reflect.deleteProperty(Object.prototype, "toJSON"); }
  expect(hooks).toBe(1); expect(socket.listeners.get("message")).toHaveLength(2);
  expect(errors).toEqual([]); expect(socket.sent).toEqual([]);
  socket.emit("message", { data: dispatch }); await flush();
  expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([{ version: 1, type: "receipt", hostId: "h", commandId: "c", attemptId: "a", status: "delivered" }]);
  expect(errors).toEqual([]);
});
test("receipt send accessor cannot forward across a reentrant reconnect", async () => {
  const errors: unknown[] = []; let hooks = 0;
  const { socket, reconnect } = setup(async (item) => ({ id: item.attemptId, status: "delivered" }), (error) => errors.push(error));
  Object.defineProperty(socket, "send", { configurable: true, get() { hooks++; reconnect(); return (raw: string) => socket.sent.push(raw); } });
  try { socket.emit("message", { data: dispatch }); await flush(); }
  finally { Reflect.deleteProperty(socket, "send"); }
  expect(hooks).toBe(1); expect(socket.listeners.get("message")).toHaveLength(2);
  expect(errors).toEqual([]); expect(socket.sent).toEqual([]);
  socket.emit("message", { data: dispatch }); await flush();
  expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([{ version: 1, type: "receipt", hostId: "h", commandId: "c", attemptId: "a", status: "delivered" }]);
  expect(errors).toEqual([]);
});
