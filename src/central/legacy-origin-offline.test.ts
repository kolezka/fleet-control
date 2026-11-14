import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import type { CentralCommandStore } from "./application/commands.ts";
import { createCentralApp } from "./server.ts";

const allowedOrigin = "https://allowed.example";

function fixture(allowedOrigins?: readonly string[]) {
  const calls: string[] = [];
  const commands: CentralCommandStore = {
    async submit(input) {
      calls.push("submit");
      return { command: { ...input, id: "command", status: "queued", createdAt: "now", updatedAt: "now" }, created: true };
    },
    async get() { throw new Error("unexpected get"); },
    async list() { throw new Error("unexpected list"); },
    async transition() { throw new Error("unexpected transition"); },
  };
  const auth = new CentralAuth([{ tokenHash: createHash("sha256").update("token").digest("hex"), principal: { name: "operator", role: "operator" } }]);
  const app = createCentralApp({ auth, commands, identities: { async matches() { return true; } }, allowedOrigins });
  return { app, calls };
}

for (const [label, allowlist, origin, allowed] of [
  ["absent header", [allowedOrigin], undefined, true],
  ["allowed origin", [allowedOrigin], allowedOrigin, true],
  ["denied origin", [allowedOrigin], "https://denied.example", false],
  ["empty origin", [allowedOrigin], "", false],
  ["empty origin with undefined allowlist", undefined, "", false],
  ["nonempty origin with undefined allowlist", undefined, allowedOrigin, false],
  ["absent origin with undefined allowlist", undefined, undefined, true],
  ["empty origin with empty allowlist", [], "", false],
  ["nonempty origin with empty allowlist", [], allowedOrigin, false],
  ["absent origin with empty allowlist", [], undefined, true],
  ["explicitly allowed empty origin", [""], "", true],
] as const) {
  test(`legacy command submission: ${label}`, async () => {
    const { app, calls } = fixture(allowlist);
    const response = await app.request("/api/commands", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json", ...(origin === undefined ? {} : { origin }) },
      body: JSON.stringify({ hostId: "host", target: "session", text: "work", idempotencyKey: "key" }),
    });
    expect(response.status).toBe(allowed ? 201 : 403);
    expect(calls).toEqual(allowed ? ["submit"] : []);
    if (!allowed) expect(await response.json()).toEqual({ error: "unsafe origin" });
  });
}
