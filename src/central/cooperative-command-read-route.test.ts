import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CommandError } from "../domain/commands.ts";
import { CentralAuth } from "./auth.ts";
import { createCooperativeCentralApp, type CooperativeCommands } from "./cooperative-server.ts";
import type { CooperativeClaims } from "./data/cooperative-claims.ts";
import type { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const auth = new CentralAuth([
  { tokenHash: hash("operator"), principal: { name: "alice", role: "operator" } },
  { tokenHash: hash("host"), principal: { name: "host", role: "host", hostId: "host-a" } },
  { tokenHash: hash("supervisor"), principal: { name: "supervisor", role: "supervisor", principalId: "identity", hostId: "host-a", session: "session-a" } },
]);
const command = { id: "cmd-00000000-0000-4000-8000-000000000001", idempotencyKey: "one", hostId: "host-a", target: "session-a", actor: "alice", text: "Read fixture", status: "queued" as const, createdAt: "2026-11-13T12:00:00.000Z", updatedAt: "2026-11-13T12:00:00.000Z" };
const cursor = Buffer.from(JSON.stringify([command.createdAt, command.id, command.hostId, command.target, null])).toString("base64url");
const scoped = "/api/commands?hostId=host-a&target=session-a";
const headers = (who = "operator") => ({ authorization: `Bearer ${who}` });

function fixture(overrides: Partial<CooperativeCommands> = {}) {
  const calls: unknown[] = [];
  const commands: CooperativeCommands = {
    async submitBounded() { throw new Error("writes are not used"); },
    async listBounded(...args) { calls.push(args); return { commands: [command], nextCursor: cursor }; },
    async getBounded(id) { calls.push(id); return command; },
    ...overrides,
  };
  const app = createCooperativeCentralApp({ auth, commands, identities: { async matches() { return true; } }, claims: {} as CooperativeClaims, lifecycle: {} as CooperativeLifecycle, inspection: { async inspectBounded() { return null; } }, allowedOrigins: ["https://allowed.example"] });
  return { app, calls };
}

test("command list requires operator role before any store read", async () => {
  const f = fixture();
  for (const [who, status] of [["missing", 401], ["host", 403], ["supervisor", 403]] as const) {
    expect((await f.app.request(scoped, { headers: headers(who) })).status).toBe(status);
  }
  expect(f.calls).toEqual([]);
});

test("command list returns explicit scoped page with default four and continuation", async () => {
  const f = fixture();
  const first = await f.app.request(scoped, { headers: headers() });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ commands: [command], nextCursor: cursor });
  const next = await f.app.request(`${scoped}&limit=1&cursor=${cursor}`, { headers: headers() });
  expect(next.status).toBe(200);
  expect(f.calls).toEqual([[undefined, { hostId: "host-a", target: "session-a" }, { limit: 4, cursor: undefined }], [undefined, { hostId: "host-a", target: "session-a" }, { limit: 1, cursor }]]);
});

test("command list rejects missing, duplicate, unknown and malformed query values without reads", async () => {
  const f = fixture();
  const invalid = ["/api/commands", "/api/commands?hostId=host-a", "/api/commands?target=session-a", `${scoped}&hostId=host-b`, `${scoped}&target=session-b`, `${scoped}&limit=1&limit=2`, `${scoped}&cursor=a&cursor=b`, `${scoped}&status=queued`, `${scoped}&unknown=x`, `${scoped}&limit=0`, `${scoped}&limit=5`, `${scoped}&limit=01`, `${scoped}&limit=1.5`, `${scoped}&limit=`, `${scoped}&cursor=`, `${scoped}&cursor=a%2Bb`, `${scoped}&cursor=${"a".repeat(8193)}`, "/api/commands?hostId=%00&target=session-a", "/api/commands?hostId=%20&target=session-a", "/api/commands?hostId=host-a&target=", `/api/commands?hostId=${"a".repeat(257)}&target=session-a`, `/api/commands?hostId=host-a&target=${"a".repeat(257)}`];
  for (const url of invalid) expect((await f.app.request(url, { headers: headers() })).status).toBe(400);
  expect(f.calls).toEqual([]);
});

test("command list preserves store cursor validation errors", async () => {
  const f = fixture({ async listBounded() { throw new CommandError("invalid", "invalid cursor"); } });
  const response = await f.app.request(`${scoped}&cursor=${cursor}`, { headers: headers() });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid cursor" });
});

test("command list returns generic server failures without internal detail", async () => {
  const f = fixture({ async listBounded() { throw new Error("private database detail"); } });
  const response = await f.app.request(scoped, { headers: headers() });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "request failed" });
});

test("command list caps serialized UTF-8 responses at two MiB", async () => {
  const f = fixture({ async listBounded() { return { commands: [{ ...command, text: "界".repeat(800_000) }], nextCursor: null }; } });
  const response = await f.app.request(scoped, { headers: headers() });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "request failed" });
});

test("new command reads preserve origin middleware", async () => {
  const f = fixture();
  for (const path of [scoped, `/api/commands/${command.id}`]) {
    expect((await f.app.request(path, { headers: { ...headers(), origin: "https://blocked.example" } })).status).toBe(403);
    expect((await f.app.request(path, { headers: { ...headers(), origin: "https://allowed.example" } })).status).toBe(200);
  }
  expect(f.calls).toHaveLength(2);
});

test("command get requires operator role and returns bounded command with authorization scope", async () => {
  const f = fixture();
  const path = `/api/commands/${command.id}`;
  for (const [who, status] of [["missing", 401], ["host", 403], ["supervisor", 403]] as const) {
    expect((await f.app.request(path, { headers: headers(who) })).status).toBe(status);
  }
  expect(f.calls).toEqual([]);
  const response = await f.app.request(path, { headers: headers() });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ command });
  expect(f.calls).toEqual([command.id]);
});

test("command get preserves not-found and generic server errors", async () => {
  for (const [error, status, message] of [[new CommandError("not_found", "command not found"), 404, "command not found"], [new Error("private database detail"), 500, "request failed"]] as const) {
    const f = fixture({ async getBounded() { throw error; } });
    const response = await f.app.request(`/api/commands/${command.id}`, { headers: headers() });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  }
});
