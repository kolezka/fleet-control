import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Commands } from "./data/commands.ts";
import type { Command } from "./domain/commands.ts";
import { Deliverer } from "./application/delivery.ts";
import { buildMcpServer } from "./mcp.ts";

test("command_deliver describes queued attempts and does not resend unknown outcomes", async () => {
  const command: Command = {
    id: "cmd-test", idempotencyKey: "test-key", target: "session", actor: "operator",
    text: "instruction", status: "delivery_unknown", createdAt: "", updatedAt: "",
  };
  let sends = 0;
  let transitions = 0;
  let ioCalls = 0;
  const commands = {
    get: (id: string) => { expect(id).toBe(command.id); return command; },
    events: (id: string) => { expect(id).toBe(command.id); return []; },
    transition: () => { transitions++; throw new Error("unexpected transition"); },
  } as unknown as Commands;
  const unexpectedIO = async () => { ioCalls++; throw new Error("unexpected IO"); };
  const deliverer = new Deliverer(commands, async () => { sends++; throw new Error("unexpected send"); }, {
    mkdtemp: unexpectedIO, write: unexpectedIO, rm: unexpectedIO,
  });
  const server = buildMcpServer({ commands, deliverer });
  const client = new Client({ name: "delivery-description-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const submitDescription = tools.find((tool) => tool.name === "command_submit")?.description;
    expect(submitDescription).toMatch(/not proof.*full.*message/i);
    const description = tools.find((tool) => tool.name === "command_deliver")?.description;
    expect(description).toMatch(/attempt delivery of a queued command/i);
    expect(description).not.toMatch(/refus(?:ed|al)/i);
    expect(description).toMatch(/delivery_unknown/);

    const response = await client.callTool({ name: "command_deliver", arguments: { id: command.id } });
    expect(response.isError).not.toBe(true);
    const result = JSON.parse((response.content as { text: string }[])[0]!.text);
    expect(result).toEqual({ command, events: [] });
    expect(sends).toBe(0);
    expect(transitions).toBe(0);
    expect(ioCalls).toBe(0);
  } finally {
    await client.close();
    await server.close();
  }
});
