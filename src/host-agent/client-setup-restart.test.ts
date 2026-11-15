import { expect, test } from "bun:test";
import { HostAgentClient, type HostSocket } from "./client.ts";

class Socket implements HostSocket {
  listeners = new Map<string, ((event: any) => void)[]>();
  sent: string[] = [];
  closed = 0;
  onListen: (type: string) => void = () => {};
  addEventListener(type: string, listener: (event: any) => void) {
    this.onListen(type);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send(raw: string) { this.sent.push(raw); }
  close() { this.closed++; }
}
const dispatch = (attemptId: string) => JSON.stringify({ version: 1, type: "dispatch", hostId: "h", commandId: "c", attemptId, target: "s", text: "hello" });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function setup() {
  const sockets: Socket[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  const errors: unknown[] = [];
  const executed: string[] = [];
  let client!: HostAgentClient;
  let restarted = false;
  client = new HostAgentClient({ url: "wss://example.com", hostId: "h", token: "secret",
    socketFactory: () => {
      const socket = new Socket();
      if (sockets.length === 0) {
        // Restart from inside setup of the first socket, once.
        socket.onListen = (type) => { if (type === "close" && !restarted) { restarted = true; client.stop(); client.start(); } };
      }
      sockets.push(socket);
      return socket;
    },
    execute: async (item) => { executed.push(item.attemptId); return { id: item.attemptId, status: "delivered" }; },
    onError: (error) => errors.push(error),
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer as typeof timers[number]); if (index >= 0) timers.splice(index, 1); },
  });
  return { client, sockets, timers, errors, executed };
}

test("stop and start during first socket setup leave the second socket live and owned", async () => {
  const { client, sockets, timers, errors, executed } = setup();
  expect(() => client.start()).not.toThrow();
  expect(sockets).toHaveLength(2);
  const [first, second] = sockets as [Socket, Socket];
  expect(first.closed).toBe(1);
  expect(second.closed).toBe(0);
  expect(errors).toEqual([]);
  expect(timers).toHaveLength(0);

  // The second socket carries traffic.
  second.emit("open");
  second.emit("message", { data: dispatch("a2") });
  await flush();
  expect(executed).toEqual(["a2"]);
  expect(second.sent.map((raw) => JSON.parse(raw).attemptId)).toEqual(["a2"]);
  client.sendInventory(["s"]);
  expect(second.sent).toHaveLength(2);

  // The client still runs: losing the second socket schedules a reconnect.
  second.emit("close");
  expect(timers.map((timer) => timer.delay)).toEqual([1000]);
  client.stop();
  expect(errors).toEqual([]);
});

test("events on the superseded first socket are ignored", async () => {
  const { client, sockets, timers, errors, executed } = setup();
  client.start();
  const [first, second] = sockets as [Socket, Socket];
  first.emit("open");
  first.emit("message", { data: dispatch("a1") });
  first.emit("message", { data: "invalid" });
  first.emit("error", new Error("old socket error"));
  first.emit("close");
  await flush();
  expect(executed).toEqual([]);
  expect(first.sent).toEqual([]);
  expect(first.closed).toBe(1);
  expect(errors).toEqual([]);
  expect(timers).toHaveLength(0);
  expect(sockets).toHaveLength(2);
  expect(second.closed).toBe(0);
  client.sendInventory([]);
  expect(second.sent).toHaveLength(1);
  client.stop();
  expect(second.closed).toBe(1);
});
