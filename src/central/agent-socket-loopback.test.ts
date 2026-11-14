import { afterEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { AgentSockets } from "./agent-sockets.ts";
import { MAX_AGENT_MESSAGE_BYTES, type AgentDispatch, type AgentReceipt } from "../domain/agent-protocol.ts";
import { HostAgentClient, type HostClientOptions, type HostSocket } from "../host-agent/client.ts";

// AgentSockets and HostAgentClient joined by a real Bun WebSocket on 127.0.0.1.
// Production does not wire dispatch: createHostSocketServer refuses every receipt and exposes
// no dispatch. This file mounts the registry itself, so it shows the two ends agree on the wire.
// It is not an integrated delivery path.
const hostId = "host-a";
const token = "loopback-host-token";
type Outcome = Awaited<ReturnType<HostClientOptions["execute"]>>;
type Data = { hostId: string };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function waitFor(predicate: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await Bun.sleep(5); }
  throw new Error(`timed out waiting for ${what}`);
}

const dispatchFor = (attemptId: string, text = "hello"): AgentDispatch => ({ version: 1, type: "dispatch", hostId, commandId: `command-${attemptId}`, attemptId, target: "supervisor", text });
const receiptFor = (attemptId: string, status: AgentReceipt["status"]): AgentReceipt => ({ version: 1, type: "receipt", hostId, commandId: `command-${attemptId}`, attemptId, status });

function central(validateAttempt: (attemptId: string) => boolean | Promise<boolean> = () => true) {
  const receipts: AgentReceipt[] = [];
  const closes: number[] = [];
  const accepted: ServerWebSocket<Data>[] = [];
  const sockets = new AgentSockets({
    validateAttempt: (_host, _command, attemptId) => validateAttempt(attemptId),
    onReceipt: (receipt) => { receipts.push(receipt); },
    onInventory: () => {},
  });
  const server = Bun.serve<Data>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });
      return server.upgrade(request, { data: { hostId } }) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) { if (sockets.connect(socket.data.hostId, socket)) accepted.push(socket); },
      message(socket, message) { void sockets.message(socket.data.hostId, socket, message).catch(() => {}); },
      close(socket, code) { closes.push(code); sockets.disconnect(socket.data.hostId, socket); },
    },
  });
  cleanups.push(() => { void server.stop(true); });
  const published = () => JSON.stringify(sockets.listHosts()) === JSON.stringify([{ hostId, sessions: ["supervisor"] }]);
  return { sockets, receipts, closes, accepted, published, url: `ws://127.0.0.1:${server.port}/agent` };
}

function host(url: string, execute: (dispatch: Readonly<AgentDispatch>) => Promise<Outcome>) {
  const errors: unknown[] = [];
  const retries: (() => void)[] = [];
  const opened: WebSocket[] = [];
  const RealSocket = WebSocket as unknown as new (url: string, options: { headers: { Authorization: string } }) => WebSocket;
  const client = new HostAgentClient({
    url, hostId, token, allowLoopbackWsForTests: true,
    socketFactory: (target, options) => { const socket = new RealSocket(target, options); opened.push(socket); return socket as unknown as HostSocket; },
    execute, inventory: () => ["supervisor"],
    // Reconnects run only when a test asks, so no real backoff delay is involved.
    setTimer: (callback) => { retries.push(callback); return callback; },
    clearTimer: (timer) => { const index = retries.indexOf(timer as () => void); if (index >= 0) retries.splice(index, 1); },
    onError: (error) => { errors.push(error); },
  });
  cleanups.push(() => client.stop());
  return { client, errors, retries, opened, reconnect() { const retry = retries.shift(); if (!retry) throw new Error("no reconnect scheduled"); retry(); } };
}

test("dispatches cross a real WebSocket, run one at a time and return receipts in order", async () => {
  const c = central();
  const order: string[] = [];
  const seen: Readonly<AgentDispatch>[] = [];
  let active = 0;
  let overlapped = false;
  const statuses: Record<string, Outcome["status"]> = { one: "delivered", two: "started", three: "unknown" };
  const h = host(c.url, async (dispatch) => {
    if (++active > 1) overlapped = true;
    order.push(`begin ${dispatch.attemptId}`);
    seen.push(dispatch);
    await Bun.sleep(15);
    order.push(`end ${dispatch.attemptId}`);
    active--;
    return { id: dispatch.attemptId, status: statuses[dispatch.attemptId]! };
  });
  h.client.start();
  // The inventory sent on open arrives, so the bearer header and the first client frame crossed the socket.
  await waitFor(c.published, "inventory");

  // The third frame is exactly the size limit: both ends must agree on where the limit is.
  const padding = MAX_AGENT_MESSAGE_BYTES - Buffer.byteLength(JSON.stringify(dispatchFor("three", "")), "utf8");
  const sent = [dispatchFor("one", "zażółć gęślą jaźń 🚀"), dispatchFor("two"), dispatchFor("three", "x".repeat(padding))];
  expect(Buffer.byteLength(JSON.stringify(sent[2]), "utf8")).toBe(MAX_AGENT_MESSAGE_BYTES);
  for (const message of sent) expect(c.sockets.dispatch(message)).toBe(true);

  await waitFor(() => c.receipts.length === 3, "three receipts");
  expect(seen).toEqual(sent);
  expect(seen.every((dispatch) => Object.isFrozen(dispatch))).toBe(true);
  expect(order).toEqual(["begin one", "end one", "begin two", "end two", "begin three", "end three"]);
  expect(overlapped).toBe(false);
  // Only a journaled delivery is reported as delivered.
  expect(c.receipts).toEqual([receiptFor("one", "delivered"), receiptFor("two", "unknown"), receiptFor("three", "unknown")]);
  expect(h.errors).toEqual([]);
  expect(c.closes).toEqual([]);

  h.client.stop();
  await waitFor(() => c.closes.length === 1, "server close");
  expect(c.closes).toEqual([1000]);
  expect(c.sockets.listHosts()).toEqual([]);
  expect(h.retries).toEqual([]);
  expect(c.sockets.dispatch(dispatchFor("late"))).toBe(false);
});

const invalidFrames: [string, () => string | Uint8Array, number][] = [
  ["text that is not JSON", () => "not json", 1008],
  ["a dispatch for another host", () => JSON.stringify({ ...dispatchFor("x"), hostId: "host-b" }), 1008],
  ["a dispatch with an extra field", () => JSON.stringify({ ...dispatchFor("x"), extra: true }), 1008],
  ["a dispatch one byte over the limit", () => {
    const padding = MAX_AGENT_MESSAGE_BYTES + 1 - Buffer.byteLength(JSON.stringify(dispatchFor("x", "")), "utf8");
    return JSON.stringify(dispatchFor("x", "x".repeat(padding)));
  }, 1009],
  ["a binary frame", () => new TextEncoder().encode(JSON.stringify(dispatchFor("x"))), 1008],
];

test.each(invalidFrames)("the host closes a real socket on %s, runs nothing and can reconnect", async (_name, frame, code) => {
  const c = central();
  const executed: string[] = [];
  const h = host(c.url, async (dispatch) => { executed.push(dispatch.attemptId); return { id: dispatch.attemptId, status: "delivered" }; });
  h.client.start();
  await waitFor(c.published, "inventory");

  c.accepted[0]!.send(frame());
  await waitFor(() => c.closes.length === 1, "server close");
  expect(c.closes).toEqual([code]);
  expect(c.sockets.listHosts()).toEqual([]);
  expect(h.retries).toHaveLength(1);

  // Positive control: the same host comes back on a new socket and runs a valid dispatch.
  h.reconnect();
  await waitFor(c.published, "inventory after reconnect");
  expect(c.sockets.dispatch(dispatchFor("valid"))).toBe(true);
  await waitFor(() => c.receipts.length === 1, "receipt");
  expect(executed).toEqual(["valid"]);
  expect(c.receipts).toEqual([receiptFor("valid", "delivered")]);
});

test("at 100 pending dispatches the next one closes the socket, and queued work never runs", async () => {
  const c = central();
  const executed: string[] = [];
  const gate = Promise.withResolvers<void>();
  const h = host(c.url, async (dispatch) => {
    executed.push(dispatch.attemptId);
    if (dispatch.attemptId === "queued-0") await gate.promise;
    return { id: dispatch.attemptId, status: "delivered" };
  });
  h.client.start();
  await waitFor(c.published, "inventory");

  for (let index = 0; index < 100; index++) expect(c.sockets.dispatch(dispatchFor(`queued-${index}`))).toBe(true);
  await waitFor(() => executed.length === 1, "first dispatch to start");
  await Bun.sleep(50);
  expect(c.closes).toEqual([]);
  expect(c.sockets.dispatch(dispatchFor("one-too-many"))).toBe(true);
  await waitFor(() => c.closes.length === 1, "server close");
  expect(c.closes).toEqual([1008]);

  h.reconnect();
  await waitFor(c.published, "inventory after reconnect");
  gate.resolve();
  // Positive control: work sent on the new connection runs, behind the abandoned queue.
  expect(c.sockets.dispatch(dispatchFor("fresh"))).toBe(true);
  await waitFor(() => c.receipts.length === 1, "receipt");
  // The started attempt finished after its connection closed: no receipt, and nothing replays it.
  expect(executed).toEqual(["queued-0", "fresh"]);
  expect(c.receipts).toEqual([receiptFor("fresh", "delivered")]);
});

test("a receipt whose validation ends after the host reconnected is dropped", async () => {
  const slow = Promise.withResolvers<boolean>();
  const asked: string[] = [];
  const c = central((attemptId) => { asked.push(attemptId); return attemptId === "slow" ? slow.promise : true; });
  const h = host(c.url, async (dispatch) => ({ id: dispatch.attemptId, status: "delivered" }));
  h.client.start();
  await waitFor(c.published, "inventory");

  expect(c.sockets.dispatch(dispatchFor("slow"))).toBe(true);
  await waitFor(() => asked.length === 1, "validation to start");
  h.opened[0]!.close();
  await waitFor(() => c.closes.length === 1 && h.retries.length === 1, "disconnect");
  h.reconnect();
  await waitFor(c.published, "inventory after reconnect");

  slow.resolve(true);
  expect(c.sockets.dispatch(dispatchFor("next"))).toBe(true);
  await waitFor(() => c.receipts.length === 1, "receipt");
  expect(asked).toEqual(["slow", "next"]);
  expect(c.receipts).toEqual([receiptFor("next", "delivered")]);
  // The new connection was not closed for the old receipt.
  expect(c.closes).toHaveLength(1);
  expect(c.published()).toBe(true);
});
