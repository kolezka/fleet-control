import { expect, test } from "bun:test";
import { AgentSockets, type AgentSocket } from "./agent-sockets.ts";
import type { AgentDispatch } from "../domain/agent-protocol.ts";
import { HostAgentClient, type HostSocket } from "../host-agent/client.ts";

// Lone surrogates can be stored as U+FFFD and alias a different id, so every host socket boundary rejects them.
class FakeAgentSocket implements AgentSocket {
  sent: string[] = [];
  closed: [number, string][] = [];
  send(message: string) { this.sent.push(message); return message.length; }
  close(code: number, reason: string) { this.closed.push([code, reason]); }
}
const options = { validateAttempt: () => true, onReceipt: () => {}, onInventory: () => {} };
const dispatch: AgentDispatch = { version: 1, type: "dispatch", hostId: "host-a", commandId: "cmd", attemptId: "try", target: "supervisor", text: "hello" };
const receipt = { version: 1, type: "receipt", hostId: "host-a", commandId: "cmd", attemptId: "try", status: "delivered" };

test("central refuses outgoing dispatch fields with lone surrogates", () => {
  for (const field of ["commandId", "attemptId", "target", "text"] as const) {
    const sockets = new AgentSockets(options);
    const socket = new FakeAgentSocket();
    expect(sockets.connect("host-a", socket)).toBe(true);
    expect(() => sockets.dispatch({ ...dispatch, [field]: "a\ud800" })).toThrow("invalid dispatch");
    expect(socket.sent).toEqual([]);
    expect(sockets.dispatch({ ...dispatch, [field]: "a\u{1F600}" })).toBe(true);
  }
});

test("central rejects a connect host id with a lone surrogate", () => {
  const sockets = new AgentSockets(options);
  const socket = new FakeAgentSocket();
  expect(sockets.connect("host-\udc00", socket)).toBe(false);
  expect(socket.closed).toEqual([[1008, "connection rejected"]]);
});

test("central closes a receipt whose host id has a lone surrogate", async () => {
  const received: unknown[] = [];
  const sockets = new AgentSockets({ ...options, onReceipt: (value) => { received.push(value); } });
  const socket = new FakeAgentSocket();
  expect(sockets.connect("host-a", socket)).toBe(true);
  await sockets.message("host-a", socket, JSON.stringify({ ...receipt, hostId: "host-\ud800" }));
  expect(socket.closed[0]?.[0]).toBe(1008);
  expect(received).toEqual([]);
});

class FakeHostSocket implements HostSocket {
  listeners = new Map<string, ((event: any) => void)[]>();
  closed: (number | undefined)[] = [];
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send() {}
  close(code?: number) { this.closed.push(code); }
}

function client(overrides: { hostId?: string; token?: string; execute?: () => Promise<any> } = {}) {
  const sockets: FakeHostSocket[] = [];
  const instance = new HostAgentClient({
    url: "wss://central.example/agent", hostId: overrides.hostId ?? "h", token: overrides.token ?? "secret",
    socketFactory: () => { const socket = new FakeHostSocket(); sockets.push(socket); return socket; },
    execute: overrides.execute ?? (async (item) => ({ id: item.attemptId, status: "delivered" })),
    setTimer: () => ({}), clearTimer: () => {},
  });
  return { instance, sockets };
}

test("host client constructor rejects a host id or token with a lone surrogate", () => {
  expect(() => client({ hostId: "h\ud800" })).toThrow("host and token required");
  expect(() => client({ token: "secret\udc00" })).toThrow("host and token required");
  expect(() => client({ hostId: "h\u{1F600}" })).not.toThrow();
});

test("host client never executes a dispatch with a lone surrogate in commandId or target", async () => {
  for (const field of ["commandId", "target"]) {
    let executed = false;
    const { instance, sockets } = client({ execute: async () => { executed = true; return { id: "try", status: "delivered" }; } });
    instance.start();
    sockets[0]!.emit("message", { data: JSON.stringify({ ...dispatch, hostId: "h", [field]: "x\ud800" }) });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(executed).toBe(false);
    expect(sockets[0]!.closed).toEqual([1008]);
  }
});
