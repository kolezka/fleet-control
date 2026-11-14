import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "../central/auth.ts";
import { MAX_AGENT_MESSAGE_BYTES, type AgentInventory } from "../central/agent-sockets.ts";
import { createHostSocketServer, type HostSocketData } from "../central/host-socket-server.ts";
import { HostAgentClient, type HostClientOptions, type HostSocket } from "./client.ts";

// HostAgentClient publishing inventory to the production host socket adapter over a real
// Bun WebSocket on 127.0.0.1. The fake-socket tests in inventory-snapshot.test.ts cover
// reentrancy and socket object reuse; this file shows what actually crosses the wire.
const hostId = "host-a";
const token = "inventory-loopback-token";
const auth = new CentralAuth([{ tokenHash: createHash("sha256").update(token).digest("hex"), principal: { name: "host", role: "host", hostId } }]);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function waitFor(predicate: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await Bun.sleep(5); }
  throw new Error(`timed out waiting for ${what}`);
}
// Long enough for a frame that was wrongly sent to arrive and be recorded.
const settle = () => Bun.sleep(60);

function central(onInventory: (inventory: AgentInventory) => void | Promise<void> = () => {}) {
  const inventories: string[][] = [];
  const frames: number[] = [];
  const closes: number[] = [];
  const adapter = createHostSocketServer({ auth, onInventory: (inventory) => { inventories.push(inventory.sessions); return onInventory(inventory); } });
  const server = Bun.serve<HostSocketData>({
    hostname: "127.0.0.1", port: 0, fetch: adapter.fetch,
    websocket: {
      ...adapter.websocket,
      message(socket, message) { frames.push(typeof message === "string" ? Buffer.byteLength(message, "utf8") : -1); adapter.websocket.message(socket, message); },
      close(socket, code) { closes.push(code); adapter.websocket.close(socket); },
    },
  });
  cleanups.push(() => { void server.stop(true); });
  const sessions = () => { const hosts = adapter.listHosts(); return hosts.length === 1 && hosts[0]!.hostId === hostId ? hosts[0]!.sessions : undefined; };
  const shows = (expected: string[] | null) => JSON.stringify(sessions()) === JSON.stringify(expected);
  return { adapter, inventories, frames, closes, sessions, shows, url: `ws://127.0.0.1:${server.port}/api/host/socket` };
}

function host(url: string, inventory?: HostClientOptions["inventory"]) {
  const errors: unknown[] = [];
  const retries: (() => void)[] = [];
  const closes: number[] = [];
  const RealSocket = WebSocket as unknown as new (url: string, options: { headers: { Authorization: string } }) => WebSocket;
  const opened: WebSocket[] = [];
  const client = new HostAgentClient({
    url, hostId, token, allowLoopbackWsForTests: true, inventory,
    socketFactory: (target, options) => {
      const socket = new RealSocket(target, options);
      socket.addEventListener("close", (event) => closes.push(event.code));
      opened.push(socket);
      return socket as unknown as HostSocket;
    },
    execute: async () => { throw new Error("dispatch disabled"); },
    // Reconnects run only when a test asks, so no real backoff delay is involved.
    setTimer: (callback) => { retries.push(callback); return callback; },
    clearTimer: (timer) => { const index = retries.indexOf(timer as () => void); if (index >= 0) retries.splice(index, 1); },
    onError: (error) => { errors.push(error); },
  });
  cleanups.push(() => client.stop());
  return { client, errors, retries, closes, opened, reconnect() { const retry = retries.shift(); if (!retry) throw new Error("no reconnect scheduled"); retry(); } };
}

// 256 distinct sessions whose inventory frame is exactly `bytes` long.
function sized(bytes: number): string[] {
  const sessions = Array.from({ length: 256 }, (_, index) => `${index}`.padStart(3, "0").padEnd(256, "x"));
  let extra = Buffer.byteLength(JSON.stringify({ version: 1, type: "inventory", hostId, sessions }), "utf8") - bytes;
  for (let index = 0; extra > 0; index++) { const cut = Math.min(extra, 250); sessions[index] = sessions[index]!.slice(0, 256 - cut); extra -= cut; }
  return sessions;
}

test("the provider's inventory arrives on open and a manual snapshot replaces it unchanged", async () => {
  const c = central();
  let providerCalls = 0;
  const h = host(c.url, () => { providerCalls++; return ["first"]; });
  h.client.start();
  await waitFor(() => c.shows(["first"]), "inventory on open");
  const input = ["captured", "zażółć gęślą", "会话 🚀"];
  let reads = 0;
  Object.defineProperty(input, 0, { get() { return ++reads === 1 ? "captured" : "changed"; } });
  input[Symbol.iterator] = function* (): ArrayIterator<string> { yield "iterator"; };
  Object.assign(input, { toJSON: () => ["custom"] });
  // An inherited toJSON must not change the frame either. Restored before anything else runs.
  const inherited = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  try {
    Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: () => ["inherited"] });
    h.client.sendInventory(input);
  } finally {
    if (inherited) Object.defineProperty(Array.prototype, "toJSON", inherited); else delete (Array.prototype as { toJSON?: unknown }).toJSON;
  }
  await waitFor(() => c.inventories.length === 2, "manual inventory");
  expect(reads).toBe(1);
  expect(providerCalls).toBe(1);
  expect(c.inventories).toEqual([["first"], ["captured", "zażółć gęślą", "会话 🚀"]]);
  expect(c.sessions()).toEqual(["captured", "zażółć gęślą", "会话 🚀"]);
  expect(h.errors).toEqual([]);
  expect(c.closes).toEqual([]);
});

test("a frame of exactly 64 KiB arrives; one byte over is refused before sending and the socket stays open", async () => {
  const c = central();
  const h = host(c.url);
  h.client.start();
  await waitFor(() => c.shows(null), "connection");
  const largest = sized(MAX_AGENT_MESSAGE_BYTES);
  h.client.sendInventory(largest);
  await waitFor(() => c.inventories.length === 1, "largest inventory");
  expect(c.frames).toEqual([MAX_AGENT_MESSAGE_BYTES]);
  expect(c.inventories[0]).toEqual(largest);
  expect(() => h.client.sendInventory(sized(MAX_AGENT_MESSAGE_BYTES + 1))).toThrow(RangeError);
  await settle();
  expect(c.frames).toEqual([MAX_AGENT_MESSAGE_BYTES]);
  expect(c.closes).toEqual([]);
  h.client.sendInventory(["after"]);
  await waitFor(() => c.shows(["after"]), "inventory after the refused frame");
  expect(h.closes).toEqual([]);
});

test("a provider result that resolves after a reconnect is not published on the new connection", async () => {
  const c = central();
  let resolveFirst!: (sessions: string[]) => void;
  let calls = 0;
  const h = host(c.url, () => ++calls === 1 ? new Promise<string[]>((resolve) => { resolveFirst = resolve; }) : ["fresh"]);
  h.client.start();
  await waitFor(() => calls === 1 && c.shows(null), "first provider call");
  h.opened[0]!.close();
  await waitFor(() => h.retries.length === 1 && c.sessions() === undefined, "disconnect");
  h.reconnect();
  await waitFor(() => c.shows(["fresh"]), "fresh inventory");
  resolveFirst(["stale"]);
  await settle();
  expect(c.inventories).toEqual([["fresh"]]);
  expect(c.sessions()).toEqual(["fresh"]);
  expect(h.errors).toEqual([]);
});

test("a provider result that resolves while disconnected is dropped without an error", async () => {
  const c = central();
  let resolveFirst!: (sessions: string[]) => void;
  let calls = 0;
  const h = host(c.url, () => ++calls === 1 ? new Promise<string[]>((resolve) => { resolveFirst = resolve; }) : ["fresh"]);
  h.client.start();
  await waitFor(() => calls === 1 && c.shows(null), "first provider call");
  h.opened[0]!.close();
  await waitFor(() => h.retries.length === 1 && c.sessions() === undefined, "disconnect");
  resolveFirst(["stale"]);
  await settle();
  expect(h.errors).toEqual([]);
  h.reconnect();
  await waitFor(() => c.shows(["fresh"]), "fresh inventory");
  expect(c.inventories).toEqual([["fresh"]]);
});

test.each(["sent", "too large to send"])("a manual snapshot that is %s supersedes a pending provider result", async (kind) => {
  const c = central();
  let resolve!: (sessions: string[]) => void;
  let called = false;
  const h = host(c.url, () => new Promise<string[]>((r) => { called = true; resolve = r; }));
  h.client.start();
  await waitFor(() => called && c.shows(null), "provider call");
  if (kind === "sent") h.client.sendInventory(["manual"]);
  else expect(() => h.client.sendInventory(sized(MAX_AGENT_MESSAGE_BYTES + 1))).toThrow(RangeError);
  resolve(["provider"]);
  await settle();
  expect(c.inventories).toEqual(kind === "sent" ? [["manual"]] : []);
  expect(c.sessions()).toEqual(kind === "sent" ? ["manual"] : null);
  expect(c.closes).toEqual([]);
});

test("sendInventory before the socket opens throws, and the provider still publishes after open", async () => {
  const c = central();
  const h = host(c.url, () => ["first"]);
  h.client.start();
  expect(() => h.client.sendInventory(["early"])).toThrow();
  await waitFor(() => c.shows(["first"]), "inventory on open");
  expect(c.inventories).toEqual([["first"]]);
  expect(c.closes).toEqual([]);
});

test("the server closes with 1011 when its inventory handler fails; the client reconnects and publishes again", async () => {
  let failures = 0;
  const c = central(() => { if (failures++ === 0) throw new Error("store unavailable"); });
  const h = host(c.url, () => ["first"]);
  h.client.start();
  await waitFor(() => h.closes.length === 1, "client close");
  expect(h.closes).toEqual([1011]);
  expect(c.adapter.listHosts()).toEqual([]);
  expect(h.retries).toHaveLength(1);
  h.reconnect();
  await waitFor(() => c.shows(["first"]), "inventory after reconnect");
  expect(c.inventories).toEqual([["first"], ["first"]]);
  expect(h.closes).toEqual([1011]);
});

test("a second connection for the same host is closed with 1008 and the first keeps its inventory", async () => {
  const c = central();
  const first = host(c.url, () => ["first"]);
  first.client.start();
  await waitFor(() => c.shows(["first"]), "first inventory");
  const second = host(c.url, () => ["second"]);
  second.client.start();
  await waitFor(() => second.closes.length === 1, "second close");
  await settle();
  expect(second.closes).toEqual([1008]);
  expect(second.retries).toHaveLength(1);
  expect(first.closes).toEqual([]);
  expect(c.inventories).toEqual([["first"]]);
  expect(c.sessions()).toEqual(["first"]);
});

test("closeAll closes the client with 1001, and a reconnect is closed again", async () => {
  const c = central();
  const h = host(c.url, () => ["first"]);
  h.client.start();
  await waitFor(() => c.shows(["first"]), "inventory on open");
  c.adapter.closeAll();
  await waitFor(() => h.closes.length === 1 && h.retries.length === 1, "client close");
  expect(h.closes).toEqual([1001]);
  expect(c.adapter.listHosts()).toEqual([]);
  h.reconnect();
  await waitFor(() => h.closes.length === 2 && h.retries.length === 1, "second close");
  await settle();
  expect(h.closes).toEqual([1001, 1001]);
  expect(c.adapter.listHosts()).toEqual([]);
  expect(c.inventories).toEqual([["first"]]);
});

test("stop() closes with 1000, the host disappears and later inventory is refused", async () => {
  const c = central();
  const h = host(c.url, () => ["first"]);
  h.client.start();
  await waitFor(() => c.shows(["first"]), "inventory on open");
  h.client.stop();
  await waitFor(() => c.closes.length === 1, "server close");
  expect(c.closes).toEqual([1000]);
  expect(c.adapter.listHosts()).toEqual([]);
  expect(() => h.client.sendInventory(["late"])).toThrow("not connected");
  await settle();
  expect(h.retries).toEqual([]);
  expect(c.inventories).toEqual([["first"]]);
});
