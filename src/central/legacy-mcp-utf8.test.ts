import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import type { CentralCommandInput } from "./commands.ts";
import type { CentralMcpCommands } from "./mcp.ts";
import { createCentralApp } from "./server.ts";

function fixture() {
  const calls: CentralCommandInput[] = [];
  const commands: CentralMcpCommands = {
    async submit(input) {
      calls.push(input);
      return { command: { ...input, id: "command", status: "queued", createdAt: "now", updatedAt: "now" }, created: true };
    },
    async get() { throw new Error("unexpected get"); },
    async list() { throw new Error("unexpected list"); },
    async transition() { throw new Error("unexpected transition"); },
  };
  const auth = new CentralAuth([{ tokenHash: createHash("sha256").update("token").digest("hex"), principal: { name: "operator", role: "operator" } }]);
  const app = createCentralApp({ auth, commands, identities: { async matches() { return true; } } });
  const send = (body: Uint8Array) => app.request("/mcp", {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: new Uint8Array(body),
  });
  return { calls, send };
}

function requestBytes(id: string, text: string, invalidField?: "id" | "text") {
  const marker = "UTF8MARKER";
  const json = JSON.stringify({ jsonrpc: "2.0", id: invalidField === "id" ? marker : id, method: "tools/call", params: { name: "command_submit", arguments: { hostId: "host", target: "session", text: invalidField === "text" ? marker : text, idempotencyKey: "key" } } });
  if (!invalidField) return new TextEncoder().encode(json);
  const [before, after] = json.split(marker);
  return Buffer.concat([Buffer.from(before!), Buffer.from([0xc3, 0x28]), Buffer.from(after!)]);
}

for (const field of ["id", "text"] as const) {
  test(`legacy MCP rejects malformed UTF-8 in ${field} without dispatch`, async () => {
      const { calls, send } = fixture();
      const response = await send(requestBytes("request", "command", field));
      expect(calls).toHaveLength(0);
      expect(response.status).toBe(400);
    },
  );
}

test("legacy MCP accepts a valid UTF-8 replacement character", async () => {
  const { calls, send } = fixture();
  const response = await send(requestBytes("request-�", "command �"));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.id).toBe("request-�");
  expect(body.result.isError).not.toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.text).toBe("command �");
});
