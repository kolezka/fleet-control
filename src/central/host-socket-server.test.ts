import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { createHostSocketServer } from "./host-socket-server.ts";
import { MAX_AGENT_MESSAGE_BYTES, type AgentInventory } from "./agent-sockets.ts";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const auth = new CentralAuth([
  { tokenHash: hash("host-a-token"), principal: { name: "a", role: "host", hostId: "host-a" } },
  { tokenHash: hash("host-b-token"), principal: { name: "b", role: "host", hostId: "host-b" } },
  { tokenHash: hash("operator-token"), principal: { name: "operator", role: "operator" } },
]);
const inventory = (hostId: string): AgentInventory => ({ version: 1, type: "inventory", hostId, sessions: ["supervisor"] });
const servers: ReturnType<typeof Bun.serve>[] = [];
const clients: WebSocket[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); for (const server of servers.splice(0)) server.stop(true); });

function setup() {
  const inventories: AgentInventory[] = [];
  const adapter = createHostSocketServer({ auth, onInventory: (item) => { inventories.push(item); } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: adapter.fetch, websocket: adapter.websocket });
  servers.push(server);
  return { server, inventories, url: `ws://127.0.0.1:${server.port}/api/host/socket` };
}
function connect(url: string, token: string) {
  const BunSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new BunSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  clients.push(socket);
  return new Promise<WebSocket>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}
function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("upgrade rejects absent or wrong credentials, non-host principals and every origin", async () => {
  const { server } = setup();
  const url = `http://127.0.0.1:${server.port}/api/host/socket`;
  const request = (headers: Record<string, string>) => fetch(url, { headers });
  expect((await request({})).status).toBe(401);
  expect((await request({ Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await request({ Authorization: "Bearer operator-token" })).status).toBe(403);
  expect((await request({ Authorization: "Bearer host-a-token", Origin: "http://127.0.0.1" })).status).toBe(403);
  expect((await request({ Authorization: "Bearer host-a-token", Origin: "null" })).status).toBe(403);
  expect((await request({ Authorization: "Bearer host-a-token" })).status).toBe(426);
});

test("real sockets accept only inventory in authenticated host scope", async () => {
  const { url, inventories } = setup();
  const a = await connect(url, "host-a-token");
  const b = await connect(url, "host-b-token");
  a.send(JSON.stringify(inventory("host-a")));
  b.send(JSON.stringify(inventory("host-b")));
  await waitFor(() => inventories.length === 2);
  expect(inventories).toEqual([inventory("host-a"), inventory("host-b")]);
  const closing = closed(a);
  a.send(JSON.stringify(inventory("host-b")));
  expect(await closing).toBe(1008);
  b.send(JSON.stringify({ ...inventory("host-b"), sessions: ["other"] }));
  await waitFor(() => inventories.length === 3);
  expect(inventories[2]).toEqual({ ...inventory("host-b"), sessions: ["other"] });
});

test("receipts, duplicate sockets and binary frames are rejected", async () => {
  const { url, inventories } = setup();
  const a = await connect(url, "host-a-token");
  const duplicate = await connect(url, "host-a-token");
  expect(await closed(duplicate)).toBe(1008);
  const receiptClose = closed(a);
  a.send(JSON.stringify({ version: 1, type: "receipt", hostId: "host-a", commandId: "c", attemptId: "a", status: "delivered" }));
  expect(await receiptClose).toBe(1008);
  const b = await connect(url, "host-b-token");
  const binaryClose = closed(b);
  b.send(new Uint8Array([123, 125]));
  expect(await binaryClose).toBe(1003);
  expect(inventories).toEqual([]);
});

test("websocket payload limit rejects oversized messages", async () => {
  const { url, inventories } = setup();
  const a = await connect(url, "host-a-token");
  const closing = closed(a);
  a.send("x".repeat(MAX_AGENT_MESSAGE_BYTES + 1));
  expect([1009, 1006]).toContain(await closing);
  expect(inventories).toEqual([]);
});

test("closeAll closes accepted sockets with 1001 and rejects later opens", async () => {
  const inventories: AgentInventory[] = [];
  const adapter = createHostSocketServer({ auth, onInventory: (item) => { inventories.push(item); } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: adapter.fetch, websocket: adapter.websocket });
  servers.push(server);
  const url = `ws://127.0.0.1:${server.port}/api/host/socket`;
  const first = await connect(url, "host-a-token");
  await waitFor(() => adapter.listHosts().length === 1);
  const firstClosed = closed(first);
  adapter.closeAll();
  expect(await firstClosed).toBe(1001);
  await waitFor(() => adapter.listHosts().length === 0);
  const late = await connect(url, "host-b-token");
  expect(await closed(late)).toBe(1001);
  expect(adapter.listHosts()).toEqual([]);
});
