import { expect, test } from "bun:test";
import { AgentSockets, type AgentSocket } from "./agent-sockets.ts";

test("inventory callbacks may finish out of order and after disconnect", async () => {
  let releaseOld!: () => void;
  let releaseNew!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
  const started: string[] = [];
  const completed: string[] = [];
  const sockets = new AgentSockets({
    validateAttempt: () => true,
    onReceipt: () => {},
    onInventory: async ({ sessions }) => {
      const version = sessions[0]!;
      started.push(version);
      await (version === "old" ? oldGate : newGate);
      completed.push(version);
    },
  });
  const socket: AgentSocket = { send: () => {}, close: () => {} };
  const inventory = (session: string) => JSON.stringify({ version: 1, type: "inventory", hostId: "host-a", sessions: [session] });

  expect(sockets.connect("host-a", socket)).toBe(true);
  const oldMessage = sockets.message("host-a", socket, inventory("old"));
  const newMessage = sockets.message("host-a", socket, inventory("new"));
  try {
    expect(started).toEqual(["old", "new"]);
    expect(completed).toEqual([]);
    expect(sockets.listHosts()).toEqual([{ hostId: "host-a", sessions: ["new"] }]);

    releaseNew();
    await newMessage;
    expect(completed).toEqual(["new"]);
    expect(sockets.listHosts()).toEqual([{ hostId: "host-a", sessions: ["new"] }]);

    sockets.disconnect("host-a", socket);
    expect(sockets.listHosts()).toEqual([]);
    releaseOld();
    await oldMessage;
    expect(completed).toEqual(["new", "old"]);
    expect(sockets.listHosts()).toEqual([]);
  } finally {
    releaseOld();
    releaseNew();
    await Promise.allSettled([oldMessage, newMessage]);
  }
}, 1000);
