import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { CentralAuth } from "./auth.ts";
import { createHostSocketServer, type HostSocketData } from "./host-socket-server.ts";

const inventory = (session: string) => JSON.stringify({ version: 1, type: "inventory", hostId: "host-a", sessions: [session] });

test("stale inventory failure cannot disconnect a reopened socket, but current failure does", async () => {
  let rejectOld!: (error: Error) => void;
  let rejectCurrent!: (error: Error) => void;
  let calls = 0;
  const adapter = createHostSocketServer({
    auth: {} as CentralAuth,
    onInventory: () => {
      calls++;
      if (calls === 1) return new Promise<void>((_, reject) => { rejectOld = reject; });
      if (calls === 3) return new Promise<void>((_, reject) => { rejectCurrent = reject; });
    },
  });
  const closed: [number, string][] = [];
  const socket = { data: { hostId: "host-a" }, send: () => 1, close: (code: number, reason: string) => { closed.push([code, reason]); } } as unknown as ServerWebSocket<HostSocketData>;
  adapter.websocket.open(socket);
  adapter.websocket.message(socket, inventory("old"));
  expect(calls).toBe(1);
  adapter.websocket.close(socket);
  adapter.websocket.open(socket);
  adapter.websocket.message(socket, inventory("new"));
  expect(calls).toBe(2);
  expect(adapter.listHosts()).toEqual([{ hostId: "host-a", sessions: ["new"] }]);
  rejectOld(new Error("old failure"));
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toEqual([]);
  expect(adapter.listHosts()).toEqual([{ hostId: "host-a", sessions: ["new"] }]);
  adapter.websocket.message(socket, inventory("current"));
  expect(calls).toBe(3);
  rejectCurrent(new Error("current failure"));
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toEqual([[1011, "inventory failed"]]);
  expect(adapter.listHosts()).toEqual([]);
});

test("duplicate open preserves the pending message generation", async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  const adapter = createHostSocketServer({ auth: {} as CentralAuth, onInventory: () => {
    calls++;
    return new Promise<void>((_, fail) => { reject = fail; });
  } });
  const closed: [number, string][] = [];
  const socket = { data: { hostId: "host-a" }, send: () => 1, close: (code: number, reason: string) => { closed.push([code, reason]); } } as unknown as ServerWebSocket<HostSocketData>;
  adapter.websocket.open(socket);
  adapter.websocket.message(socket, inventory("current"));
  expect(calls).toBe(1);
  adapter.websocket.open(socket);
  expect(closed).toEqual([]);
  expect(adapter.listHosts()).toEqual([{ hostId: "host-a", sessions: ["current"] }]);
  reject(new Error("current failure"));
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toEqual([[1011, "inventory failed"]]);
  expect(adapter.listHosts()).toEqual([]);
});

test("inventory failure disconnects the host captured before data mutation", async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  const adapter = createHostSocketServer({ auth: {} as CentralAuth, onInventory: () => {
    calls++;
    return new Promise<void>((_, fail) => { reject = fail; });
  } });
  const closed: [number, string][] = [];
  const socket = { data: { hostId: "host-a" }, send: () => 1, close: (code: number, reason: string) => { closed.push([code, reason]); } } as unknown as ServerWebSocket<HostSocketData>;
  adapter.websocket.open(socket);
  adapter.websocket.message(socket, inventory("current"));
  expect(calls).toBe(1);
  expect(adapter.listHosts()).toEqual([{ hostId: "host-a", sessions: ["current"] }]);
  socket.data.hostId = "host-b";
  reject(new Error("current failure"));
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toEqual([[1011, "inventory failed"]]);
  expect(adapter.listHosts()).toEqual([]);
});

test("multiple pending inventory failures close a current socket only once", async () => {
  const rejections: ((error: Error) => void)[] = [];
  const adapter = createHostSocketServer({ auth: {} as CentralAuth, onInventory: () =>
    new Promise<void>((_, reject) => { rejections.push(reject); }) });
  const closed: [number, string][] = [];
  const socket = { data: { hostId: "host-a" }, send: () => 1, close: (code: number, reason: string) => { closed.push([code, reason]); } } as unknown as ServerWebSocket<HostSocketData>;
  adapter.websocket.open(socket);
  adapter.websocket.message(socket, inventory("first"));
  adapter.websocket.message(socket, inventory("second"));
  expect(rejections).toHaveLength(2);
  expect(adapter.listHosts()).toEqual([{ hostId: "host-a", sessions: ["second"] }]);
  rejections[0]!(new Error("first failure"));
  rejections[1]!(new Error("second failure"));
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toEqual([[1011, "inventory failed"]]);
  expect(adapter.listHosts()).toEqual([]);
});


test("accepted host identity survives mutation before message and close", () => {
  const seen: string[] = [];
  const adapter = createHostSocketServer({ auth: {} as CentralAuth, onInventory: (value) => { seen.push(value.hostId); } });
  const socket = { data: { hostId: "host-a" }, send: () => 1, close: () => {} } as unknown as ServerWebSocket<HostSocketData>;
  adapter.websocket.open(socket);
  socket.data.hostId = "host-b";
  adapter.websocket.message(socket, inventory("current"));
  expect(seen).toEqual(["host-a"]);
  expect(adapter.listHosts()).toEqual([{ hostId: "host-a", sessions: ["current"] }]);
  adapter.websocket.open(socket);
  adapter.websocket.close(socket);
  expect(adapter.listHosts()).toEqual([]);
});

test("rejected reentrant open stays closed and preserves the accepted generation", async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  const adapter = createHostSocketServer({ auth: {} as CentralAuth, onInventory: () => {
    calls++;
    return new Promise<void>((_, fail) => { reject = fail; });
  } });
  const acceptedClosed: number[] = [];
  const occupied = { data: { hostId: "host-a" }, send: () => 1, close: (code: number) => { acceptedClosed.push(code); } } as unknown as ServerWebSocket<HostSocketData>;
  adapter.websocket.open(occupied);
  adapter.websocket.message(occupied, inventory("current"));
  expect(calls).toBe(1);
  const closed: number[] = [];
  const socket = { data: { hostId: "host-a" }, send: () => 1, close: (code: number) => {
    closed.push(code);
    if (code === 1008) { socket.data.hostId = "host-b"; adapter.websocket.open(socket); }
  } } as unknown as ServerWebSocket<HostSocketData>;
  adapter.websocket.open(socket);
  socket.data.hostId = "host-c";
  adapter.websocket.message(socket, JSON.stringify({ version: 1, type: "inventory", hostId: "host-b", sessions: ["ignored"] }));
  adapter.websocket.close(socket);
  expect(closed).toEqual([1008]);
  expect(calls).toBe(1);
  expect(adapter.listHosts()).toEqual([{ hostId: "host-a", sessions: ["current"] }]);
  reject(new Error("current failure"));
  await Promise.resolve(); await Promise.resolve();
  expect(acceptedClosed).toEqual([1011]);
  expect(closed).toEqual([1008]);
  expect(adapter.listHosts()).toEqual([]);
});

test("message and close without an accepted open are no-ops", () => {
  const adapter = createHostSocketServer({ auth: {} as CentralAuth, onInventory: () => { throw new Error("unexpected"); } });
  const socket = { data: { hostId: "host-a" }, send: () => 1, close: () => { throw new Error("unexpected close"); } } as unknown as ServerWebSocket<HostSocketData>;
  adapter.websocket.message(socket, inventory("ignored"));
  adapter.websocket.close(socket);
  expect(adapter.listHosts()).toEqual([]);
});

test("close uses the accepted identity after data mutation", () => {
  const adapter = createHostSocketServer({ auth: {} as CentralAuth, onInventory: () => {} });
  const socket = { data: { hostId: "host-a" }, send: () => 1, close: () => {} } as unknown as ServerWebSocket<HostSocketData>;
  adapter.websocket.open(socket);
  socket.data.hostId = "host-b";
  adapter.websocket.close(socket);
  expect(adapter.listHosts()).toEqual([]);
});
