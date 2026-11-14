import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { handleMcp } from "./mcp.ts";
import type { Requests } from "./data/requests.ts";
import { CentralAuth } from "./central/auth.ts";
import type { CentralCommandStore } from "./central/application/commands.ts";
import type { CentralRequests } from "./central/data/requests.ts";
import { createCentralApp } from "./central/server.ts";

for (const mode of ["local", "legacy central"] as const) {
  test(mode + " MCP rejects null array elements before request creation", async () => {
    const calls: Record<string, unknown>[] = [];
    const requests = { create(input: Record<string, unknown>) { calls.push(input); return { ...input }; } };
    const auth = new CentralAuth([{ tokenHash: createHash("sha256").update("token").digest("hex"), principal: { role: "supervisor", name: "supervisor", principalId: "id", hostId: "host", session: "session" } }]);
    const app = createCentralApp({ auth, commands: {} as CentralCommandStore, requests: requests as unknown as CentralRequests, identities: { async matches() { return true; } } });
    const send = async (args: object) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_create", arguments: args } });
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer token", host: "localhost" };
      const response = mode === "local"
        ? await handleMcp(new Request("http://localhost/mcp", { method: "POST", headers, body }), { commands: {} as never, deliverer: {} as never, requests: requests as unknown as Requests }, ["localhost"], "supervisor")
        : await app.request("/mcp", { method: "POST", headers, body });
      expect(response.status).toBe(200);
      return await response.json();
    };
    const base = { runId: "run", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Proceed?" };
    for (const field of ["evidence", "allowedResponses"] as const) {
      const result = await send({ ...base, [field]: ["valid", null] });
      expect(result.result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    }
    const valid = await send({ ...base, evidence: ["proof"], allowedResponses: ["approve", "reject"] });
    expect(valid.result.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.evidence).toEqual(["proof"]);
    expect(calls[0]?.allowedResponses).toEqual(["approve", "reject"]);
  });
}
