import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Commands } from "./data/commands.ts";
import { Deliverer, type Sender } from "./delivery.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

const sent: string[] = [];
const fakeSend: Sender = async (session, file) => {
  sent.push(await Bun.file(file).text());
  return { exitCode: 0, stdout: `${session}: delivered`, stderr: "" };
};
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;

let server: ReturnType<typeof serve>;
let commands: Commands;
beforeAll(() => {
  const store = new Store(":memory:");
  commands = new Commands(store.db);
  server = serve({ fleet, store, control: { commands, deliverer: new Deliverer(commands, fakeSend) } }, 0);
});
afterAll(() => server.stop(true));

async function connect() {
  const client = new Client({ name: "fleet-control-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}mcp`)));
  return client;
}
const body = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

test("an MCP client lists the command tools", async () => {
  const client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(["command_deliver", "command_events", "command_get", "command_list", "command_report", "command_respond", "command_submit"]);
  await client.close();
});

test("submit, deliver, respond and report through MCP keep each step separate", async () => {
  const client = await connect();
  const submitted = body(await client.callTool({ name: "command_submit", arguments: { target: "supervisor", text: "run bun test", idempotencyKey: "mcp-0001", actor: "macbook" } }));
  const id = submitted.command.id;
  expect(submitted.command.status).toBe("delivered");
  expect(sent.at(-1)).toContain(`Fleet Control command ${id} from macbook:`);

  const retry = body(await client.callTool({ name: "command_submit", arguments: { target: "supervisor", text: "run bun test", idempotencyKey: "mcp-0001", actor: "macbook" } }));
  expect(retry.created).toBe(false);
  expect(retry.command.id).toBe(id);
  expect(sent.filter((m) => m.includes(id))).toHaveLength(1);

  const early = await client.callTool({ name: "command_report", arguments: { id, status: "completed", actor: "supervisor", evidence: "x" } });
  expect(early.isError).toBe(true);

  body(await client.callTool({ name: "command_respond", arguments: { id, decision: "accepted", actor: "supervisor" } }));
  const done = body(await client.callTool({ name: "command_report", arguments: { id, status: "completed", actor: "supervisor", evidence: "33 pass" } }));
  expect(done.command.status).toBe("completed");

  const history = body(await client.callTool({ name: "command_get", arguments: { id } }));
  expect(history.events.map((e: { status: string }) => e.status)).toEqual(["queued", "delivering", "delivered", "accepted", "completed"]);
  await client.close();
});

test("REST and MCP share one queue", async () => {
  const res = await fetch(`${server.url}api/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.url.origin },
    body: JSON.stringify({ idempotencyKey: "rest-0001", target: "supervisor", text: "status please" }),
  });
  expect(res.status).toBe(201);
  const { command } = (await res.json()) as { command: { id: string; actor: string } };
  expect(command.actor).toBe("web-ui");
  const client = await connect();
  const got = body(await client.callTool({ name: "command_get", arguments: { id: command.id } }));
  expect(got.command.status).toBe("delivered");
  await client.close();
});

test("REST refuses cross-origin writes, bad JSON and key conflicts", async () => {
  const post = (b: string, origin = server.url.origin) =>
    fetch(`${server.url}api/commands`, { method: "POST", headers: { "content-type": "application/json", origin }, body: b });
  expect((await post("{}", "https://evil.example")).status).toBe(403);
  expect((await post("not json")).status).toBe(400);
  expect((await post(JSON.stringify({ idempotencyKey: "rest-0001", target: "supervisor", text: "something else" }))).status).toBe(409);
  expect((await fetch(`${server.url}api/commands/cmd-missing`)).status).toBe(404);
});

test("MCP refuses a foreign Host header (DNS rebinding) and a browser Origin from elsewhere", async () => {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const foreignHost = await fetch(`${server.url}mcp`, { method: "POST", headers: { ...headers, host: "evil.example" }, body: init });
  expect(foreignHost.status).toBe(403);
  const foreignOrigin = await fetch(`${server.url}mcp`, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: init });
  expect(foreignOrigin.status).toBe(403);
});

