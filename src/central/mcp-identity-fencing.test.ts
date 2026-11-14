import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCentralMcpServer, type CentralMcpCommands } from "./mcp.ts";
import type { CentralRequests } from "./data/requests.ts";

const calls = [
  ["command_respond", { id: "cmd", decision: "accepted" }, "transitionScoped"],
  ["command_report", { id: "cmd", status: "running", evidence: "proof" }, "transitionScoped"],
  ["run_register", { runId: "run", phase: "one" }, "registerRun"],
  ["phase_update", { runId: "run", expectedRevision: 1, phaseStatus: "running", newRevision: false }, "updatePhase"],
  ["request_create", { runId: "run", expectedRevision: 1, kind: "approval", question: "ok?" }, "create"],
  ["request_acknowledge", { requestId: "req" }, "acknowledge"],
  ["request_withdraw", { requestId: "req", reason: "reason" }, "withdraw"],
] as const;

for (const [tool, args, method] of calls) {
  test(tool + " fences the captured supervisor in the mutation transaction", async () => {
    const tx = {} as never;
    const principal = { role: "supervisor" as const, name: "supervisor", principalId: "id", hostId: "host", session: "session" };
    const expected = { name: "supervisor", principalId: "id", hostId: "host", session: "session" };
    let active = false, writes = 0, locks = 0, observed: unknown;
    const mutation = async (...parameters: any[]) => {
      const guard = parameters.at(-1);
      await guard(tx, { hostId: "host", session: "session" });
      writes++;
      if (method === "updatePhase") return { run: { orchestrator: parameters[0].actor }, staled: [] };
      if (method === "registerRun") return { orchestrator: parameters[0].orchestrator };
      if (method === "transitionScoped") return { actor: parameters[2] };
      return { origin: parameters[0].origin ?? parameters[0].actor };
    };
    const commands = { [method]: mutation } as unknown as CentralMcpCommands;
    const requests = { [method]: mutation } as unknown as CentralRequests;
    const identities = { async lockActive(received: unknown, identity: unknown) { expect(received).toBe(tx); observed = { ...identity as object }; locks++; return active; } };
    const server = buildCentralMcpServer({ commands, requests, identities }, principal);
    principal.name = "changed"; principal.hostId = "changed";
    const client = new Client({ name: "test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    try {
      expect((await client.callTool({ name: tool, arguments: args })).isError).toBe(true);
      expect(writes).toBe(0);
      active = true;
      expect((await client.callTool({ name: tool, arguments: args })).isError).not.toBe(true);
      expect(writes).toBe(1); expect(locks).toBe(2); expect(observed).toEqual(expected);
    } finally { await client.close(); await server.close(); }
  });
}
