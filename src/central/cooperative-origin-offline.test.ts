import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";
import type { CooperativeClaims } from "./cooperative-claims.ts";
import type { CooperativeLifecycle } from "./cooperative-lifecycle.ts";

const operator = { name: "operator", role: "operator" as const };
const supervisor = { name: "supervisor", role: "supervisor" as const, principalId: "supervisor-id", hostId: "host", session: "session" };
const incarnationId = "12345678-1234-4234-8234-123456789012";
const incarnationToken = "a".repeat(43);
const allowedOrigin = "https://allowed.example";
const deniedOrigin = "https://denied.example";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function fixture() {
  const calls: string[] = [];
  const auth = new CentralAuth([
    { tokenHash: hash("operator-token"), principal: operator },
    { tokenHash: hash("supervisor-token"), principal: supervisor },
  ]);
  const app = createCooperativeCentralApp({
    auth,
    identities: { async matches() { return true; } },
    commands: {
      async submitBounded(input) {
        calls.push("submit");
        return { command: { ...input, id: "command", status: "queued" as const, createdAt: "now", updatedAt: "now" }, created: true };
      },
      async getBounded() { calls.push("get"); throw new Error("unexpected get"); },
      async listBounded() { calls.push("list"); return { commands: [], nextCursor: null }; },
    },
    claims: { async claim(_principal: unknown, _credential: unknown, requestId: string) { calls.push("claim:" + requestId); return null; } } as unknown as CooperativeClaims,
    lifecycle: { async report() { calls.push("report"); throw new Error("unexpected report"); } } as unknown as CooperativeLifecycle,
    inspection: { async inspectBounded() { calls.push("inspect"); return null; } },
    allowedOrigins: [allowedOrigin],
  });
  return { app, calls };
}

for (const [label, origin, allowed] of [
  ["allowed", allowedOrigin, true],
  ["denied", deniedOrigin, false],
  ["absent", undefined, true],
] as const) {
  test(`operator command POST with ${label} Origin`, async () => {
    const { app, calls } = fixture();
    const response = await app.request("/api/commands", {
      method: "POST",
      headers: { authorization: "Bearer operator-token", "content-type": "application/json", ...(origin === undefined ? {} : { origin }) },
      body: JSON.stringify({ hostId: "host", target: "session", text: "work", idempotencyKey: "key" }),
    });
    expect(response.status).toBe(allowed ? 201 : 403);
    expect(calls).toEqual(allowed ? ["submit"] : []);
    if (allowed) expect((await response.json()).command.actor).toBe("operator");
    else expect(await response.json()).toEqual({ error: "unsafe origin" });
  });

  test(`supervisor MCP POST with ${label} Origin`, async () => {
    const { app, calls } = fixture();
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer supervisor-token", "x-fleet-incarnation-id": incarnationId, "x-fleet-incarnation-token": incarnationToken, "content-type": "application/json", accept: "application/json, text/event-stream", ...(origin === undefined ? {} : { origin }) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cooperative_claim", arguments: { requestId: "request" } } }),
    });
    expect(response.status).toBe(allowed ? 200 : 403);
    expect(calls).toEqual(allowed ? ["claim:request"] : []);
    const body = await response.json();
    if (allowed) {
      expect(body.result.isError).not.toBe(true);
      expect(JSON.parse(body.result.content[0].text)).toEqual({ command: null });
    } else expect(body).toEqual({ error: "unsafe origin" });
  });
}
