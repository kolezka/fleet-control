import { expect, test } from "bun:test";
import { AgentSockets, type AgentSocket } from "./agent-sockets.ts";
import { MAX_AGENT_MESSAGE_BYTES, type AgentDispatch } from "../domain/agent-protocol.ts";

class FakeSocket implements AgentSocket {
  sent: string[] = [];
  result: unknown = 1;
  send(message: string) { this.sent.push(message); return this.result; }
  close() {}
}

function setup() {
  const sockets = new AgentSockets({ validateAttempt: () => false, onReceipt: () => {}, onInventory: () => {} });
  const socket = new FakeSocket();
  expect(sockets.connect("host-a", socket)).toBe(true);
  return { sockets, socket };
}

const message: AgentDispatch = { version: 1, type: "dispatch", hostId: "host-a", commandId: "cmd", attemptId: "try", target: "supervisor", text: "hello" };

test("dispatch ignores own and inherited toJSON and unrelated fields", () => {
  for (const input of [
    { ...message, extra: "unexpected", toJSON: () => ({ ...message, hostId: "host-b", text: "changed" }) },
    Object.assign(Object.create({ toJSON: () => ({ ...message, hostId: "host-b" }) }), message),
  ]) {
    const { sockets, socket } = setup();
    expect(sockets.dispatch(input)).toBe(true);
    expect(JSON.parse(socket.sent[0]!)).toEqual(message);
  }
});

test("dispatch reads each field once and sends the same values it validates and routes", () => {
  const { sockets, socket } = setup();
  const reads: Record<string, number> = {};
  const input = {} as AgentDispatch;
  for (const [key, value] of Object.entries(message)) {
    Object.defineProperty(input, key, { enumerable: true, get() {
      reads[key] = (reads[key] ?? 0) + 1;
      return reads[key] === 1 ? value : "changed";
    } });
  }
  expect(sockets.dispatch(input)).toBe(true);
  expect(JSON.parse(socket.sent[0]!)).toEqual(message);
  expect(reads).toEqual(Object.fromEntries(Object.keys(message).map((key) => [key, 1])));
});

test("dispatch stops reading after the first invalid field", () => {
  const cases = [
    ["version", 2, "type"],
    ["type", "invalid", "commandId"],
    ["commandId", "", "attemptId"],
    ["attemptId", "", "target"],
    ["target", "", "text"],
  ] as const;
  for (const [invalidField, invalidValue, laterField] of cases) {
    const { sockets, socket } = setup();
    const input = { ...message, [invalidField]: invalidValue };
    let laterReads = 0;
    Object.defineProperty(input, laterField, { get() { laterReads++; throw new Error("later getter read"); } });
    expect(() => sockets.dispatch(input as AgentDispatch)).toThrow("invalid dispatch");
    expect(laterReads).toBe(0);
    expect(socket.sent).toEqual([]);
  }
});

test("dispatch does not inspect fields after an absent socket", () => {
  const { sockets } = setup();
  const input = { ...message, hostId: "absent", get version(): 1 { throw new Error("version read"); } };
  expect(sockets.dispatch(input)).toBe(false);
});

test("dispatch does not send to a socket disconnected during snapshot", () => {
  const { sockets, socket } = setup();
  const input = { ...message, get text() { sockets.disconnect("host-a", socket); return "hello"; } };
  expect(sockets.dispatch(input)).toBe(false);
  expect(socket.sent).toEqual([]);
});

test("dispatch refuses a re-registration during snapshot", () => {
  for (const reuseSocket of [true, false]) {
    const { sockets, socket } = setup();
    const replacement = reuseSocket ? socket : new FakeSocket();
    const input = { ...message, get text() {
      sockets.disconnect("host-a", socket);
      expect(sockets.connect("host-a", replacement)).toBe(true);
      return "hello";
    } };
    expect(sockets.dispatch(input)).toBe(false);
    expect(socket.sent).toEqual([]);
    expect(replacement.sent).toEqual([]);
    expect(sockets.dispatch(message)).toBe(true);
    expect(replacement.sent).toEqual([JSON.stringify(message)]);
  }
});

test("dispatch retains unavailable, validation, byte limit and send result behavior", () => {
  const { sockets, socket } = setup();
  expect(sockets.dispatch({ ...message, hostId: "absent", text: "" })).toBe(false);
  expect(() => sockets.dispatch({ ...message, text: "" })).toThrow(TypeError);
  const prefixBytes = Buffer.byteLength(JSON.stringify({ ...message, text: "" }), "utf8");
  expect(sockets.dispatch({ ...message, text: "x".repeat(MAX_AGENT_MESSAGE_BYTES - prefixBytes) })).toBe(true);
  expect(() => sockets.dispatch({ ...message, text: "x".repeat(MAX_AGENT_MESSAGE_BYTES - prefixBytes + 1) })).toThrow(RangeError);
  socket.result = 0;
  expect(sockets.dispatch(message)).toBe(false);
  socket.result = -1;
  expect(sockets.dispatch(message)).toBe(true);
  socket.result = undefined;
  expect(sockets.dispatch(message)).toBe(true);
  expect(socket.sent).toHaveLength(4);
});
