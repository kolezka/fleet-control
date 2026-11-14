import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RequestError } from "../domain/requests.ts";
import { buildCentralMcpServer, type CentralMcpCommands } from "./mcp.ts";
import type { CentralRequests } from "./data/requests.ts";

const principal = { role: "supervisor" as const, name: "supervisor", principalId: "identity", hostId: "host", session: "session" };
const identity = { name: "supervisor", principalId: "identity", hostId: "host", session: "session" };
const scope = { hostId: "host", session: "session" };
const owner = 'central-supervisor\n' + JSON.stringify(["supervisor", "identity", "host", "session"]);
const calls = [
  ["command_get", { id: "own" }, "getScoped"],
  ["command_list", { status: "queued", limit: 5, cursor: "cursor" }, "listScoped"],
  ["request_gate", { runId: "own", phase: "phase", revision: 2 }, "gateScoped"],
] as const;

async function connect(deps: Parameters<typeof buildCentralMcpServer>[0], who: Parameters<typeof buildCentralMcpServer>[1] = principal) {
  const server = buildCentralMcpServer(deps, who);
  const client = new Client({ name: "read-fencing-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("request_gate discovery distinguishes recorded responses from authority", async () => {
  const commands = {} as CentralMcpCommands;
  const requests = {} as CentralRequests;
  const { client, server } = await connect({ commands, requests });
  try {
    const { tools } = await client.listTools();
    const gate = tools.find((tool) => tool.name === "request_gate");
    expect(gate).toBeDefined();
    expect(gate!.description).toContain("recorded responses");
    expect(gate!.description).toContain("not proof of a human decision");
    expect(gate!.description).toContain("not authorization to execute");
  } finally { await client.close(); await server.close(); }
});

for (const [tool, args, method] of calls) {
  test(tool + " fences reads with the captured identity and transaction", async () => {
    const tx = {} as never;
    let active = false, locks = 0, reads = 0, fallback = 0;
    const scoped = async (...parameters: any[]) => {
      if (method === "getScoped") expect(parameters.slice(0, 2)).toEqual(["own", scope]);
      if (method === "listScoped") expect([parameters[0], parameters[1], parameters[3]]).toEqual(["queued", scope, { limit: 5, cursor: "cursor" }]);
      if (method === "gateScoped") expect(parameters.slice(0, 4)).toEqual(["own", "phase", 2, owner]);
      const guard = parameters[method === "getScoped" ? 2 : method === "listScoped" ? 2 : 4];
      await guard(tx, scope);
      reads++;
      return method === "getScoped" ? { id: "own" } : method === "listScoped" ? { commands: [{ id: "own" }], nextCursor: null } : { approved: true, reason: "approved", requestId: "req" };
    };
    const unguarded = async () => { fallback++; throw new Error("unguarded fallback"); };
    const commands = { get: unguarded, list: unguarded, [method]: scoped } as unknown as CentralMcpCommands;
    const requests = { gate: unguarded, [method]: scoped } as unknown as CentralRequests;
    const identities = { async lockActive(received: unknown, captured: unknown) { expect(received).toBe(tx); expect(captured).toEqual(identity); locks++; return active; } };
    const input = { ...principal };
    const { client, server } = await connect({ commands, requests, identities }, input);
    input.name = "changed"; input.hostId = "changed"; input.principalId = "changed"; input.session = "changed";
    try {
      const retired = await client.callTool({ name: tool, arguments: args });
      expect(retired.isError).toBe(true);
      expect(reads).toBe(0);
      active = true;
      const result = await client.callTool({ name: tool, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(method === "getScoped" ? { command: { id: "own" } } : method === "listScoped" ? { commands: [{ id: "own" }], nextCursor: null } : { approved: true, reason: "approved", requestId: "req" });
      expect(reads).toBe(1); expect(locks).toBe(2); expect(fallback).toBe(0);
    } finally { await client.close(); await server.close(); }
  });

  test(tool + " fails closed without scoped method or identity registry", async () => {
    for (const missing of ["method", "registry"]) {
      let fallback = 0, reads = 0;
      const unguarded = async () => { fallback++; return { secret: "leaked" }; };
      const scoped = async (...parameters: any[]) => { await parameters[method === "gateScoped" ? 4 : 2]({} as never, scope); reads++; return { secret: "leaked" }; };
      const commands = { get: unguarded, list: unguarded, ...(missing === "method" ? {} : { [method]: scoped }) } as unknown as CentralMcpCommands;
      const requests = { gate: unguarded, ...(missing === "method" ? {} : { [method]: scoped }) } as unknown as CentralRequests;
      const identities = missing === "registry" ? undefined : { async lockActive() { return true; } };
      const { client, server } = await connect({ commands, requests, identities });
      try {
        expect((await client.callTool({ name: tool, arguments: args })).isError).toBe(true);
        expect(reads).toBe(0); expect(fallback).toBe(0);
      } finally { await client.close(); await server.close(); }
    }
  });
}

test("foreign and missing command and run reads return the same error", async () => {
  const guardThen = async (guard: any) => { await guard({} as never, scope); };
  const commands = { async getScoped(id: string, _scope: unknown, guard: any) { await guardThen(guard); throw new Error(id === "foreign" ? "foreign command" : "missing command"); } } as unknown as CentralMcpCommands;
  const requests = { async gateScoped(id: string, _phase: string, _revision: number, _owner: string, guard: any) { await guardThen(guard); throw new RequestError(id === "foreign" ? "forbidden" : "not_found", id); } } as unknown as CentralRequests;
  const { client, server } = await connect({ commands, requests, identities: { async lockActive() { return true; } } });
  try {
    for (const [name, args] of [["command_get", { id: "foreign" }], ["request_gate", { runId: "foreign", phase: "phase", revision: 2 }]] as const) {
      const foreign = await client.callTool({ name, arguments: args });
      const missing = await client.callTool({ name, arguments: name === "command_get" ? { id: "missing" } : { runId: "missing", phase: "phase", revision: 2 } });
      expect(foreign.isError).toBe(true); expect(missing.isError).toBe(true);
      expect(foreign.content).toEqual(missing.content);
    }
  } finally { await client.close(); await server.close(); }
});

test("operator reads remain unscoped and do not require a registry", async () => {
  const seen: unknown[] = [];
  const commands = {
    async get(id: string) { seen.push(["get", id]); return { id }; },
    async list(status: unknown, target: unknown, page: unknown) { seen.push(["list", status, target, page]); return { commands: [], nextCursor: null }; },
    async getScoped() { throw new Error("unexpected scoped read"); },
    async listScoped() { throw new Error("unexpected scoped read"); },
  } as unknown as CentralMcpCommands;
  const { client, server } = await connect({ commands }, { role: "operator", name: "operator" });
  try {
    expect((await client.callTool({ name: "command_get", arguments: { id: "foreign" } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "command_list", arguments: { status: "queued", limit: 5 } })).isError).not.toBe(true);
    expect(seen).toEqual([["get", "foreign"], ["list", "queued", undefined, { limit: 5 }]]);
  } finally { await client.close(); await server.close(); }
});
