import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";
import type { CooperativeClaims } from "./cooperative-claims.ts";
import type { CooperativeLifecycle } from "./cooperative-lifecycle.ts";

const supervisor = { name: "supervisor", role: "supervisor" as const, principalId: "supervisor-id", hostId: "host", session: "session" };
const incarnation = { incarnationId: "12345678-1234-4234-8234-123456789012", token: "a".repeat(43) };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const calls: { operation: string; args: unknown[] }[] = [];
  const app = createCooperativeCentralApp({
    auth: new CentralAuth([
      { tokenHash: hash("operator-token"), principal: { name: "operator", role: "operator" } },
      { tokenHash: hash("supervisor-token"), principal: supervisor },
    ]),
    identities: { async matches(identity) { return JSON.stringify(identity) === JSON.stringify({ principalId: supervisor.principalId, name: supervisor.name, hostId: supervisor.hostId, session: supervisor.session }); } },
    commands: {
      async submitBounded(input) { calls.push({ operation: "submit", args: [input] }); return { command: { ...input, id: "command", status: "queued", createdAt: "now", updatedAt: "now" }, created: true }; },
      async getBounded(id) { calls.push({ operation: "get", args: [id] }); throw new Error("unexpected get"); },
      async listBounded(...args) { calls.push({ operation: "list", args }); return { commands: [], nextCursor: null }; },
    },
    claims: { async claim(...args: unknown[]) { calls.push({ operation: "claim", args }); return null; } } as unknown as CooperativeClaims,
    lifecycle: { async report(...args: unknown[]) { calls.push({ operation: "report", args }); return {}; } } as unknown as CooperativeLifecycle,
    inspection: { async inspectBounded(...args) { calls.push({ operation: "inspect", args }); return null; } },
  });
  async function call(role: "operator" | "supervisor", name: string, args: object) {
    return app.request("/mcp", {
      method: "POST",
      headers: { authorization: token(role), "content-type": "application/json", accept: "application/json, text/event-stream", ...(role === "supervisor" ? { "x-fleet-incarnation-id": incarnation.incarnationId, "x-fleet-incarnation-token": incarnation.token } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
  }
  return { calls, call };
}

function token(role: "operator" | "supervisor") { return "Bearer " + role + "-token"; }

const submit = { hostId: "host", target: "session", text: "work", idempotencyKey: "key" };

for (const [role, name, args] of [
  ["operator", "cooperative_claim", { requestId: "request" }],
  ["operator", "cooperative_report", { commandId: "command", requestId: "request", status: "accepted", detail: "ok" }],
  ["supervisor", "command_submit", submit],
  ["supervisor", "command_get", { id: "command" }],
  ["supervisor", "command_list", {}],
] as const) {
  test(role + " cannot invoke " + name, async () => {
    const f = fixture();
    const response = await f.call(role, name, args);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.error).toBeUndefined();
    expect(body.result).toEqual({ isError: true, content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }] });
    expect(f.calls).toEqual([]);
  });
}

test("operator submit and active supervisor claim reach their stores", async () => {
  const f = fixture();
  const submitted = await f.call("operator", "command_submit", submit);
  expect(submitted.status).toBe(200);
  expect((await submitted.json()).result.isError).not.toBe(true);
  expect(f.calls).toEqual([{ operation: "submit", args: [{ ...submit, actor: "operator" }] }]);
  const claimed = await f.call("supervisor", "cooperative_claim", { requestId: "request" });
  expect(claimed.status).toBe(200);
  const result = await claimed.json();
  expect(result.result.isError).not.toBe(true);
  expect(JSON.parse(result.result.content[0].text)).toEqual({ command: null });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]!.operation).toBe("claim");
  expect(f.calls[1]!.args.slice(0, 3)).toEqual([supervisor, incarnation, "request"]);
  expect(typeof f.calls[1]!.args[3]).toBe("function");
});
