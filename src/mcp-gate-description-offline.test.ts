import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Commands } from "./commands.ts";
import type { Deliverer } from "./delivery.ts";
import type { Requests } from "./requests.ts";
import { buildMcpServer } from "./mcp.ts";

test("request_gate describes reported responses without claiming human authority", async () => {
  const server = buildMcpServer({ commands: {} as Commands, deliverer: {} as Deliverer, requests: {} as Requests });
  const client = new Client({ name: "gate-description-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const description = (await client.listTools()).tools.find((tool) => tool.name === "request_gate")?.description;
    expect(description).toMatch(/not proof of human approval/i);
    expect(description).toMatch(/not authoriz/i);
  } finally {
    await client.close();
    await server.close();
  }
});
