import { expect, test } from "bun:test";
import { HostAgentClient, type HostClientOptions, type HostSocket } from "./client.ts";

class FakeSocket implements HostSocket {
  listeners = new Map<string, (event: any) => void>();
  sent: string[] = [];
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, listener); }
  emit(type: string) { this.listeners.get(type)?.({}); }
  send(raw: string) { this.sent.push(raw); }
  close() {}
}
function setup(inventory?: HostClientOptions["inventory"]) {
  const sockets: FakeSocket[] = [];
  const options: HostClientOptions = { url: "wss://example.com", hostId: "host", token: "secret", inventory,
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    execute: async (dispatch) => ({ id: dispatch.attemptId, status: "delivered" }),
    setTimer: () => 1, clearTimer: () => {} };
  const client = new HostAgentClient(options);
  client.start();
  return { client, sockets, options };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const values = (socket: FakeSocket) => socket.sent.map((raw) => JSON.parse(raw).sessions);
const oversized = () => Array.from({ length: 256 }, (_, index) => `${index}`.padEnd(256, '"'));

test("captures own indices once without using source iterator or toJSON", () => {
  const { client, sockets } = setup();
  const input = ["first"];
  let reads = 0;
  Object.defineProperty(input, 0, { get() { return ++reads === 1 ? "first" : "changed"; } });
  input[Symbol.iterator] = function* (): ArrayIterator<string> { yield "iterator"; };
  Object.assign(input, { toJSON: () => ["custom"] });
  client.sendInventory(input);
  expect(reads).toBe(1);
  expect(values(sockets[0]!)).toEqual([["first"]]);
});

test("rejects a hole even when inherited; invalid does not supersede provider", async () => {
  let resolve!: (value: string[]) => void;
  const { client, sockets } = setup(() => new Promise((r) => { resolve = r; }));
  sockets[0]!.emit("open"); await flush();
  const sparse = new Array(1); Object.setPrototypeOf(sparse, Object.assign(Object.create(Array.prototype), { 0: "inherited" }));
  expect(() => client.sendInventory(sparse)).toThrow(TypeError);
  resolve(["provider"]); await flush();
  expect(values(sockets[0]!)).toEqual([["provider"]]);
});

test("newer nested valid inventory supersedes outer capture", () => {
  const { client, sockets } = setup();
  const input = ["old"];
  Object.defineProperty(input, 0, { get() { client.sendInventory(["new"]); return "old"; } });
  expect(() => client.sendInventory(input)).toThrow("stale inventory");
  expect(values(sockets[0]!)).toEqual([["new"]]);
});

test("provider capture does not publish after restart or a nested send", async () => {
  for (const restart of [false, true]) {
    let client!: HostAgentClient;
    const input = ["old"];
    Object.defineProperty(input, 0, { get() { if (restart) { client.stop(); client.start(); } else client.sendInventory(["new"]); return "old"; } });
    const fixture = setup(() => input); client = fixture.client;
    fixture.sockets[0]!.emit("open"); await flush();
    expect(values(fixture.sockets[0]!)).toEqual(restart ? [] : [["new"]]);
    if (restart) expect(values(fixture.sockets[1]!)).toEqual([]);
  }
});

test("provider getter cannot invoke a stale provider after restart", async () => {
  const { client, sockets, options } = setup();
  let reads = 0, calls = 0;
  Object.defineProperty(options, "inventory", { get() { reads++; if (reads === 1) { client.stop(); client.start(); } return () => { calls++; return ["old"]; }; } });
  sockets[0]!.emit("open"); await flush();
  expect(calls).toBe(0);
  expect(sockets[1]!.sent).toEqual([]);
});

test("serialization ignores inherited toJSON on array and envelope", () => {
  const { client, sockets } = setup();
  const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  try {
    Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: () => ["wrong"] });
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: () => ({ wrong: true }) });
    client.sendInventory(["safe"]);
  } finally {
    if (arrayDescriptor) Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor); else delete (Array.prototype as any).toJSON;
    if (objectDescriptor) Object.defineProperty(Object.prototype, "toJSON", objectDescriptor); else delete (Object.prototype as any).toJSON;
  }
  expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ version: 1, type: "inventory", hostId: "host", sessions: ["safe"] });
});

test("invalid nested send does not supersede a valid outer capture", () => {
  const { client, sockets } = setup();
  const input = ["outer"];
  Object.defineProperty(input, 0, { get() { expect(() => client.sendInventory([""])).toThrow(TypeError); return "outer"; } });
  client.sendInventory(input);
  expect(values(sockets[0]!)).toEqual([["outer"]]);
});

test("caught oversized nested send suppresses outer inventory", () => {
  const { client, sockets } = setup();
  const input = ["outer"];
  let nestedError: unknown;
  Object.defineProperty(input, 0, { get() { try { client.sendInventory(oversized()); } catch (error) { nestedError = error; } return "outer"; } });
  expect(() => client.sendInventory(input)).toThrow("stale inventory");
  expect(nestedError).toBeInstanceOf(RangeError);
  expect(values(sockets[0]!)).toEqual([]);
});

test("valid oversized or throwing send suppresses pending provider", async () => {
  for (const failure of ["oversized", "send"] as const) {
    let resolve!: (value: string[]) => void;
    const { client, sockets } = setup(() => new Promise((r) => { resolve = r; }));
    const socket = sockets[0]!;
    socket.emit("open"); await flush();
    const sendError = new Error("send failed");
    if (failure === "send") socket.send = () => { throw sendError; };
    if (failure === "oversized") expect(() => client.sendInventory(oversized())).toThrow(RangeError);
    else expect(() => client.sendInventory(["manual"])).toThrow(sendError);
    socket.send = (raw) => { socket.sent.push(raw); };
    resolve(["provider"]); await flush();
    expect(values(socket)).toEqual([]);
  }
});

test("valid manual send supersedes pending provider", async () => {
  let resolve!: (value: string[]) => void;
  const { client, sockets } = setup(() => new Promise((r) => { resolve = r; }));
  sockets[0]!.emit("open"); await flush(); client.sendInventory(["manual"]); resolve(["old"]); await flush();
  expect(values(sockets[0]!)).toEqual([["manual"]]);
});

test("rejects invalid proxy lengths without superseding a provider", async () => {
  for (const length of [NaN, -1, 1.5, Infinity]) {
    let resolve!: (value: string[]) => void;
    const { client, sockets } = setup(() => new Promise((r) => { resolve = r; }));
    sockets[0]!.emit("open"); await flush();
    const input = new Proxy(["x"], { get(target, key, receiver) { return key === "length" ? length : Reflect.get(target, key, receiver); } });
    expect(() => client.sendInventory(input)).toThrow(TypeError);
    resolve(["provider"]); await flush();
    expect(values(sockets[0]!)).toEqual([["provider"]]);
  }
});

test("invokes provider regardless of its own call property", async () => {
  const provider = Object.assign(() => ["provider"], { call: () => ["wrong"] });
  const { sockets } = setup(provider);
  sockets[0]!.emit("open"); await flush();
  expect(values(sockets[0]!)).toEqual([["provider"]]);
});

test("public stale capture reports failure after nested send", () => {
  const { client, sockets } = setup();
  const input = ["old"];
  Object.defineProperty(input, 0, { get() { client.sendInventory(["new"]); return "old"; } });
  expect(() => client.sendInventory(input)).toThrow();
  expect(values(sockets[0]!)).toEqual([["new"]]);
});

test("hostId reentry cannot send stale inventory on replacement socket", () => {
  const { client, sockets, options } = setup();
  Object.defineProperty(options, "hostId", { get() { client.stop(); client.start(); return "host"; } });
  expect(() => client.sendInventory(["old"])).toThrow();
  expect(sockets.flatMap((socket) => socket.sent)).toEqual([]);
});

test("send accessor reentry cannot publish older inventory", () => {
  const { client, sockets } = setup();
  const socket = sockets[0]!;
  let first = true;
  const send = function(this: FakeSocket, raw: string) { expect(this).toBe(socket); this.sent.push(raw); };
  Object.defineProperty(socket, "send", { get() { if (first) { first = false; client.sendInventory(["new"]); } return send; } });
  expect(() => client.sendInventory(["old"])).toThrow("stale inventory");
  expect(values(socket)).toEqual([["new"]]);
});

test("serialization reentry cannot send stale inventory on replacement socket", () => {
  const { client, sockets } = setup();
  const original = JSON.stringify;
  try {
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { client.stop(); client.start(); return original(...args); }) as typeof JSON.stringify;
    expect(() => client.sendInventory(["old"])).toThrow();
  } finally { JSON.stringify = original; }
  expect(sockets.flatMap((socket) => socket.sent)).toEqual([]);
});
