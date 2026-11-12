import { expect, test } from "bun:test";
import { HostAgentClient, type HostSocket } from "./client.ts";

class FakeSocket implements HostSocket {
  listeners = new Map<string, ((event: any) => void)[]>();
  sent: string[] = [];
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send(value: string) { this.sent.push(value); }
  close() {}
}
const dispatch = { version: 1, type: "dispatch", hostId: "h", commandId: "command", attemptId: "first", target: "supervisor", text: "hello" } as const;
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

// A throwing error observer must not reject the shared dispatch queue: later dispatches still run
// and the pending count is released, so the client does not stop accepting work after maxPending.
test("a throwing onError observer does not poison the dispatch queue", async () => {
  const sockets: FakeSocket[] = [];
  const seen: string[] = [];
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const client = new HostAgentClient({
      url: "wss://central.example/agent", hostId: "h", token: "secret-token",
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      execute: async (item) => { seen.push(item.attemptId); if (item.attemptId === "first") throw new Error("execute failed secret-token"); return { id: item.attemptId, status: "delivered" }; },
      onError: () => { throw new Error("observer failed"); },
      setTimer: () => ({}), clearTimer: () => {},
    });
    client.start();
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit("message", { data: JSON.stringify(dispatch) });
    await flush();
    for (let i = 0; i < 40; i++) socket.emit("message", { data: JSON.stringify({ ...dispatch, attemptId: `next-${i}` }) });
    for (let i = 0; i < 50 && seen.length < 41; i++) await flush();
    expect(seen.length).toBe(41);
    expect(socket.sent.filter((raw) => JSON.parse(raw).type === "receipt").length).toBe(40);
    expect(logged.length).toBe(1);
    expect(JSON.stringify(logged)).not.toContain("secret-token");
  } finally {
    console.error = original;
  }
});

test("a throwing onError observer does not stop reconnect after a socket factory failure", () => {
  const timers: (() => void)[] = [];
  let attempts = 0;
  const original = console.error;
  console.error = () => {};
  try {
    const client = new HostAgentClient({
      url: "wss://central.example/agent", hostId: "h", token: "secret-token",
      socketFactory: () => { attempts++; if (attempts === 1) throw new Error("factory failed"); return new FakeSocket(); },
      execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
      onError: () => { throw new Error("observer failed"); },
      setTimer: (callback) => { timers.push(callback); return {}; }, clearTimer: () => {},
    });
    expect(() => client.start()).not.toThrow();
    expect(timers.length).toBe(1);
    timers[0]!();
    expect(attempts).toBe(2);
  } finally {
    console.error = original;
  }
});

test("a throwing onError observer does not escape the socket error listener", () => {
  const sockets: FakeSocket[] = [];
  const original = console.error;
  console.error = () => {};
  try {
    const client = new HostAgentClient({
      url: "wss://central.example/agent", hostId: "h", token: "secret-token",
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      execute: async (item) => ({ id: item.attemptId, status: "delivered" }),
      onError: () => { throw new Error("observer failed"); },
      setTimer: () => ({}), clearTimer: () => {},
    });
    client.start();
    expect(() => sockets[0]!.emit("error", { type: "error" })).not.toThrow();
  } finally {
    console.error = original;
  }
});
