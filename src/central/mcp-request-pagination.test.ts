import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCentralMcpServer, type CentralMcpCommands } from "./mcp.ts";
import { CentralRequests } from "./data/requests.ts";

const rows = [
  { id: "a", runId: "run-a", status: "open", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "b", runId: "run-b", status: "open", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "c", runId: "run-a", status: "withdrawn", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "d", runId: "run-a", status: "open", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "e", runId: "run-a", status: "open", createdAt: "2026-01-02T00:00:00.000Z" },
].map((row) => ({ ...row, id: `req-00000000-0000-4000-8000-${row.id.padStart(12, "0")}`, origin: "supervisor", evidence: "[]", allowedResponses: "[]" }));

function database(): SQL {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("FROM central_runs")) return [{ id: "run-a", orchestrator: "supervisor" }];
    if (!query.includes("FROM central_requests")) throw new Error(`Unexpected query: ${query}`);
    const [runId, , status, , createdAt, , id, limit] = values as [string | null, unknown, string | null, unknown, string | null, unknown, string | null, number];
    return rows.filter((row) => (!runId || row.runId === runId) && (!status || row.status === status) && (!createdAt || row.createdAt > createdAt || (row.createdAt === createdAt && row.id > id!)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, limit);
  }) as unknown as SQL;
}

async function connect() {
  const commands = {} as CentralMcpCommands;
  const server = buildCentralMcpServer({ commands, requests: new CentralRequests(database()) }, { name: "operator", role: "operator" });
  const client = new Client({ name: "pagination-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

const parse = (response: unknown) => JSON.parse((response as { content: { text: string }[] }).content[0]!.text);

test("request_list continues filtered pages through the MCP surface", async () => {
  const { client, server } = await connect();
  try {
    const call = (args: Record<string, unknown>) => client.callTool({ name: "request_list", arguments: args });
    const filter = { runId: "run-a", status: "open", limit: 2 };
    const firstResponse = await call(filter);
    expect(firstResponse.isError).not.toBe(true);
    const first = parse(firstResponse);
    expect(first.runs.map((run: { id: string }) => run.id)).toEqual(["run-a"]);
    expect(first.requests.map((request: { id: string }) => request.id)).toEqual([rows[0]!.id, rows[3]!.id]);
    expect(typeof first.nextCursor).toBe("string");
    const secondResponse = await call({ ...filter, cursor: first.nextCursor });
    expect(secondResponse.isError).not.toBe(true);
    const second = parse(secondResponse);
    expect(second.requests.map((request: { id: string }) => request.id)).toEqual([rows[4]!.id]);
    expect(second.nextCursor).toBeNull();
    const empty = parse(await call({ runId: "run-b", status: "withdrawn", limit: 2 }));
    expect(empty.requests).toEqual([]);
    expect(empty.nextCursor).toBeNull();
    for (const changed of [{ ...filter, runId: "run-b" }, { ...filter, status: "withdrawn" }, { status: "open", limit: 2 }]) {
      const response = await call({ ...changed, cursor: first.nextCursor });
      expect(response.isError).toBe(true);
      expect((response.content as { text: string }[])[0]!.text).toMatch(/invalid.*cursor/i);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("request_list rejects malformed cursors and invalid limits over MCP", async () => {
  const { client, server } = await connect();
  try {
    for (const cursor of ["", "!invalid!", "not-json", Buffer.from(JSON.stringify(["time", "id"])).toString("base64url"), "a".repeat(4097)]) {
      const response = await client.callTool({ name: "request_list", arguments: { cursor } });
      expect(response.isError).toBe(true);
      expect((response.content as { text: string }[])[0]!.text).toMatch(/invalid.*cursor/i);
    }
    for (const limit of [0, 1001, 1.5]) {
      const response = await client.callTool({ name: "request_list", arguments: { limit } });
      expect(response.isError).toBe(true);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
