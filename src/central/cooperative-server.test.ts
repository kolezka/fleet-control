import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { CommandError } from "../commands.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";
import type { CentralMcpCommands } from "./mcp.ts";
import type { CooperativeClaims } from "./cooperative-claims.ts";
import type { CooperativeLifecycle } from "./cooperative-lifecycle.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const incarnationId = "00000000-0000-4000-8000-000000000001";
const token = "a".repeat(43);
const forged = "b".repeat(43);
const principal = { name: "supervisor", role: "supervisor" as const, principalId: "id", hostId: "host", session: "session" };
const auth = new CentralAuth([
  { tokenHash: hash("operator"), principal: { name: "alice", role: "operator" } },
  { tokenHash: hash("supervisor"), principal },
  { tokenHash: hash("host"), principal: { name: "host", role: "host", hostId: "host" } },
]);

function fixture(submitError?: Error) {
  let active = true;
  let fail = false;
  const calls: unknown[] = [];
  const commands: CentralMcpCommands = {
    async submit(input) { calls.push(input); if (submitError) throw submitError; return { command: { ...input, id: "cmd", status: "queued", createdAt: "now", updatedAt: "now" }, created: true }; },
    async get() { throw new Error("unused"); },
    async list() { return { commands: [], nextCursor: null }; },
    async transition() { throw new Error("legacy mutation must not run"); },
  };
  const check = (identity: unknown, credential: { incarnationId: string; token: string }) => {
    calls.push({ identity, credential });
    if (!active || credential.incarnationId !== incarnationId || credential.token !== token) throw new Error(`secret ${credential.token}`);
  };
  const claims = { async claim(identity: unknown, credential: { incarnationId: string; token: string }) { check(identity, credential); return null; } } as unknown as CooperativeClaims;
  const lifecycle = { async report(identity: unknown, credential: { incarnationId: string; token: string }) { check(identity, credential); return { status: "accepted" }; } } as unknown as CooperativeLifecycle;
  const app = createCooperativeCentralApp({ auth, commands, claims, lifecycle, inspection: { async inspectBounded() { return null; } }, identities: { async matches(identity) { if (fail) throw new Error(token); return active && JSON.stringify(identity) === JSON.stringify({ principalId: "id", name: "supervisor", hostId: "host", session: "session" }); } } });
  return { app, calls, setActive(value: boolean) { active = value; }, setFail(value: boolean) { fail = value; } };
}
const headers = (who: string, credential?: string) => ({ authorization: `Bearer ${who}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(credential ? { "x-fleet-incarnation-id": incarnationId, "x-fleet-incarnation-token": credential } : {}) });
const rpc = (method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

test("roles isolate MCP tools and fail closed for registry errors", async () => {
  const f = fixture();
  const call = (who: string, credential?: string) => f.app.request("/mcp", { method: "POST", headers: headers(who, credential), body: rpc("tools/list") });
  expect((await call("supervisor")).status).toBe(401);
  expect((await call("host")).status).toBe(403);
  const supervisor = await (await call("supervisor", token)).json();
  expect(supervisor.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["cooperative_claim", "cooperative_report"]);
  const operator = await (await call("operator")).json();
  expect(operator.result.tools.map((tool: { name: string }) => tool.name)).toContain("command_submit");
  expect(operator.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("cooperative_claim");
  f.setActive(false);
  expect((await call("supervisor", token)).status).toBe(401);
  f.setFail(true);
  const failure = await call("supervisor", token);
  expect(failure.status).toBe(401);
  expect(await failure.text()).not.toContain(token);
});

test("incarnation credentials reach store guard on every action and errors do not leak", async () => {
  const f = fixture();
  const call = (credential: string, name: string, args: object) => f.app.request("/mcp", { method: "POST", headers: headers("supervisor", credential), body: rpc("tools/call", { name, arguments: args }) });
  const bad = await call(forged, "cooperative_claim", { requestId: "one" });
  const text = await bad.text();
  expect(JSON.parse(text).result.isError).toBe(true);
  expect(text).not.toContain(forged);
  expect((await (await call(token, "cooperative_claim", { requestId: "two" })).json()).result.isError).not.toBe(true);
  expect((await (await call(forged, "cooperative_report", { commandId: "cmd", requestId: "three", status: "accepted", detail: "ok" })).json()).result.isError).toBe(true);
  expect(f.calls).toHaveLength(3);
  expect((f.calls[0] as any).identity).toEqual(principal);
  const legacy = await call(token, "command_respond", { id: "cmd", decision: "accepted" });
  expect((await legacy.json()).result?.isError ?? true).toBe(true);
});

test("only operators submit commands and request bodies are bounded", async () => {
  const f = fixture();
  const body = JSON.stringify({ hostId: "host", target: "session", text: "work", idempotencyKey: "one", actor: "spoof" });
  const submit = (who: string, data: string) => f.app.request("/api/commands", { method: "POST", headers: headers(who), body: data });
  expect((await submit("supervisor", body)).status).toBe(403);
  expect((await submit("host", body)).status).toBe(403);
  expect((await submit("operator", body)).status).toBe(201);
  expect((f.calls[0] as any).actor).toBe("alice");
  expect((await submit("operator", "x".repeat(32769))).status).toBe(413);
  expect((await f.app.request("/mcp", { method: "POST", headers: headers("operator"), body: "x".repeat(512 * 1024 + 1) })).status).toBe(413);
  expect((await f.app.request("/legacy/mcp", { method: "POST", headers: headers("supervisor", token), body: rpc("tools/list") })).status).toBe(404);
});


test("command errors retain central REST status mapping", async () => {
  const body = JSON.stringify({ hostId: "host", target: "bad target", text: "work", idempotencyKey: "one" });
  for (const [error, status] of [[new CommandError("invalid", "invalid target"), 400], [new CommandError("conflict", "key conflict"), 409], [new Error("internal secret"), 500]] as const) {
    const response = await fixture(error).app.request("/api/commands", { method: "POST", headers: headers("operator"), body });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: status === 500 ? "request failed" : error.message });
  }
});

test("MCP accepts maximum lifecycle detail including escaped and UTF-8 text", async () => {
  for (const detail of ["\u0001".repeat(65536), "界".repeat(65536), "😀".repeat(32768)]) {
    const f = fixture();
    const body = rpc("tools/call", { name: "cooperative_report", arguments: { commandId: "cmd", requestId: "report", status: "accepted", detail } });
    const response = await f.app.request("/mcp", { method: "POST", headers: headers("supervisor", token), body });
    expect(response.status).toBe(200);
    expect((await response.json()).result.isError).not.toBe(true);
    expect(f.calls).toHaveLength(1);
  }
});

test("MCP streaming rejects bodies over its limit without content length", async () => {
  const f = fixture();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  const request = new Request("http://localhost/mcp", { method: "POST", headers: headers("operator"), body, duplex: "half" } as RequestInit);
  expect((await f.app.fetch(request)).status).toBe(413);
});
