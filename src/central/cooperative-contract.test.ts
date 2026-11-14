import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import type { CentralMcpCommands } from "./mcp.ts";
import { createCooperativeCentralApp, type CooperativeCommands } from "./cooperative-server.ts";
import type { CooperativeClaims } from "./data/cooperative-claims.ts";
import type { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";

// @ts-expect-error Legacy commands alone cannot satisfy the cooperative contract.
const rejectLegacy: CooperativeCommands = {} as CentralMcpCommands;
void rejectLegacy;

test("cooperative REST and MCP route exclusively to bounded command methods", async () => {
  const calls: string[] = [];
  const command = { id: "cmd", hostId: "host", target: "session", text: "work", idempotencyKey: "key", actor: "alice", status: "queued" as const, createdAt: "now", updatedAt: "now" };
  const commands = {
    async submitBounded() { calls.push("submitBounded"); return { command, created: true }; },
    async getBounded() { calls.push("getBounded"); return command; },
    async listBounded() { calls.push("listBounded"); return { commands: [command], nextCursor: null }; },
    async submit() { throw new Error("unbounded submit"); },
    async get() { throw new Error("unbounded get"); },
    async list() { throw new Error("unbounded list"); },
  };
  const auth = new CentralAuth([{ tokenHash: createHash("sha256").update("token").digest("hex"), principal: { name: "alice", role: "operator" } }]);
  const app = createCooperativeCentralApp({ auth, commands, identities: { async matches() { return true; } }, claims: {} as CooperativeClaims, lifecycle: {} as CooperativeLifecycle, inspection: { async inspectBounded() { return null; } } });
  const headers = { authorization: "Bearer token", "content-type": "application/json", accept: "application/json, text/event-stream" };
  const response = await app.request("/api/commands", { method: "POST", headers, body: JSON.stringify(command) });
  expect(response.status).toBe(201);
  for (const [name, args] of [["command_submit", command], ["command_get", { id: "cmd" }], ["command_list", {}]] as const) {
    const result = await app.request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    expect((await result.json()).result.isError).not.toBe(true);
  }
  expect(calls).toEqual(["submitBounded", "submitBounded", "getBounded", "listBounded"]);
});
