import { expect, test } from "bun:test";
import { AgentSockets, type AgentSocket } from "./agent-sockets.ts";
import type { AgentInventory } from "../domain/agent-protocol.ts";

function setup() {
  const closed: [number, string][] = [];
  const inventories: AgentInventory[] = [];
  const socket: AgentSocket = { send: () => {}, close: (code, reason) => { closed.push([code, reason]); } };
  const sockets = new AgentSockets({
    validateAttempt: () => true,
    onReceipt: () => {},
    onInventory: (inventory) => { inventories.push(inventory); },
  });
  expect(sockets.connect("host-a", socket)).toBe(true);
  return { socket, sockets, closed, inventories };
}

test.each(["\ud800", "\udfff", "prefix\ud800suffix", "\udc00\ud800"])("rejects malformed inventory session %s", async (session) => {
  const { socket, sockets, closed, inventories } = setup();
  await sockets.message("host-a", socket, JSON.stringify({ version: 1, type: "inventory", hostId: "host-a", sessions: ["valid", session] }));
  expect(closed).toEqual([[1008, "invalid message"]]);
  expect(inventories).toEqual([]);
  expect(sockets.listHosts()).toEqual([]);
});

test("accepts well-formed Unicode inventory sessions", async () => {
  const { socket, sockets, closed, inventories } = setup();
  const inventory: AgentInventory = { version: 1, type: "inventory", hostId: "host-a", sessions: ["café", "session-😀", "�"] };
  await sockets.message("host-a", socket, JSON.stringify(inventory));
  expect(closed).toEqual([]);
  expect(inventories).toEqual([inventory]);
  expect(sockets.listHosts()).toEqual([{ hostId: "host-a", sessions: inventory.sessions }]);
});
