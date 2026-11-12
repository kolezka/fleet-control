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

