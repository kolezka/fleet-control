import { describe, expect, test } from "bun:test";
import { AgentSockets, MAX_AGENT_MESSAGE_BYTES, type AgentDispatch, type AgentSocket } from "./agent-sockets.ts";

class FakeSocket implements AgentSocket {
  sent: string[] = [];
  closed: [number, string][] = [];
  send(message: string) { this.sent.push(message); return message.length; }
  close(code: number, reason: string) { this.closed.push([code, reason]); }
}

const receipt = { version: 1, type: "receipt", hostId: "host-a", commandId: "cmd-1", attemptId: "try-1", status: "delivered" } as const;
const inventory = { version: 1, type: "inventory", hostId: "host-a", sessions: ["supervisor"] } as const;
const dispatch: AgentDispatch = { version: 1, type: "dispatch", hostId: "host-a", commandId: "cmd-1", attemptId: "try-1", target: "supervisor", text: "hello" };

function setup(validateAttempt: (host: string, command: string, attempt: string) => boolean | Promise<boolean> = () => true) {
  const receipts: unknown[] = [];
  const inventories: unknown[] = [];
  const sockets = new AgentSockets({ validateAttempt, onReceipt: (value) => { receipts.push(value); }, onInventory: (value) => { inventories.push(value); } });
  const socket = new FakeSocket();
  expect(sockets.connect("host-a", socket)).toBe(true);
  return { sockets, socket, receipts, inventories };
}

describe("agent sockets", () => {
  test("dispatches only on the active connection and accepts explicit receipt and inventory", async () => {
    const checked: string[][] = [];
    const { sockets, socket, receipts, inventories } = setup((...args) => { checked.push(args); return true; });
    expect(sockets.dispatch(dispatch)).toBe(true);
    expect(JSON.parse(socket.sent[0]!)).toEqual(dispatch);
    expect(receipts).toEqual([]);
    await sockets.message("host-a", socket, JSON.stringify(receipt));
    await sockets.message("host-a", socket, JSON.stringify(inventory));
    expect(checked).toEqual([["host-a", "cmd-1", "try-1"]]);
    expect(receipts).toEqual([receipt]);
    expect(inventories).toEqual([inventory]);
    sockets.disconnect("host-a", socket);
    expect(sockets.dispatch(dispatch)).toBe(false);
  });

  test("rejects another connection and stale disconnect cannot release the replacement", () => {
    const { sockets, socket } = setup();
    const second = new FakeSocket();
    expect(sockets.connect("host-a", second)).toBe(false);
    expect(second.closed[0]?.[0]).toBe(1008);
    sockets.disconnect("host-a", second);
    expect(sockets.dispatch(dispatch)).toBe(true);
    sockets.disconnect("host-a", socket);
    const replacement = new FakeSocket();
    expect(sockets.connect("host-a", replacement)).toBe(true);
    sockets.disconnect("host-a", socket);
    expect(sockets.dispatch(dispatch)).toBe(true);
    expect(replacement.sent).toHaveLength(1);
  });

  test.each([
    "{", "null", "[]", JSON.stringify({ ...receipt, version: 2 }),
    JSON.stringify({ ...receipt, hostId: "host-b" }), JSON.stringify({ ...receipt, status: "completed" }),
    JSON.stringify({ ...receipt, extra: 1 }), JSON.stringify({ ...inventory, sessions: [""] }),
    JSON.stringify({ version: 1, type: "command", hostId: "host-a" }),
  ])("closes malformed or out of scope messages: %s", async (raw) => {
    const { sockets, socket, receipts, inventories } = setup();
    await sockets.message("host-a", socket, raw);
    expect(socket.closed[0]?.[0]).toBe(1008);
    await sockets.message("host-a", socket, JSON.stringify(receipt));
    expect(receipts).toEqual([]);
    expect(inventories).toEqual([]);
    expect(sockets.dispatch(dispatch)).toBe(false);
  });

  test("checks byte size and rejects binary frames", async () => {
    const first = setup();
    await first.sockets.message("host-a", first.socket, "é".repeat(MAX_AGENT_MESSAGE_BYTES / 2 + 1));
    expect(first.socket.closed[0]?.[0]).toBe(1009);
    const second = setup();
    await second.sockets.message("host-a", second.socket, new Uint8Array([123, 125]));
    expect(second.socket.closed[0]?.[0]).toBe(1003);
  });

  test("invalid command or attempt closes without a receipt", async () => {
    const { sockets, socket, receipts } = setup(() => false);
    await sockets.message("host-a", socket, JSON.stringify(receipt));
    expect(socket.closed[0]?.[0]).toBe(1008);
    expect(receipts).toEqual([]);
  });

  test("a pending validation cannot report after disconnect and replacement", async () => {
    let resolve!: (valid: boolean) => void;
    const { sockets, socket, receipts } = setup(() => new Promise<boolean>((done) => { resolve = done; }));
    const pending = sockets.message("host-a", socket, JSON.stringify(receipt));
    sockets.disconnect("host-a", socket);
    const replacement = new FakeSocket();
    expect(sockets.connect("host-a", replacement)).toBe(true);
    resolve(true);
    await pending;
    expect(receipts).toEqual([]);
  });

  test("presence and inventory belong only to the accepted live socket", async () => {
    const { sockets, socket } = setup();
    expect(sockets.listHosts()).toEqual([{ hostId: "host-a", sessions: null }]);
    await sockets.message("host-a", socket, JSON.stringify(inventory));
    expect(sockets.listHosts()).toEqual([{ hostId: "host-a", sessions: ["supervisor"] }]);
    const rejected = new FakeSocket();
    sockets.connect("host-a", rejected);
    sockets.disconnect("host-a", rejected);
    expect(sockets.listHosts()).toHaveLength(1);
    sockets.disconnect("host-a", socket);
    const replacement = new FakeSocket();
    sockets.connect("host-a", replacement);
    sockets.disconnect("host-a", socket);
    await sockets.message("host-a", socket, JSON.stringify(inventory));
    expect(sockets.listHosts()).toEqual([{ hostId: "host-a", sessions: null }]);
    await sockets.message("host-a", replacement, JSON.stringify({ ...inventory, sessions: Array(257).fill("x") }));
    expect(sockets.listHosts()).toEqual([]);
  });

  test("bounds outbound messages and performs no retries", () => {
    const { sockets, socket } = setup();
    expect(() => sockets.dispatch({ ...dispatch, text: "x".repeat(MAX_AGENT_MESSAGE_BYTES) })).toThrow(RangeError);
    expect(socket.sent).toEqual([]);
  });
});
