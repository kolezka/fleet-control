import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Commands } from "./data/commands.ts";
import { Deliverer } from "./application/delivery.ts";
import type { Sender } from "./domain/delivery.ts";
import { Requests } from "./data/requests.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

const fakeSend: Sender = async (session) => ({ exitCode: 0, stdout: `${session}: delivered`, stderr: "" });
const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;

let server: ReturnType<typeof serve>;
beforeAll(() => {
  const store = new Store(":memory:");
  const commands = new Commands(store.db);
  server = serve({ fleet, store, control: { commands, deliverer: new Deliverer(commands, fakeSend), requests: new Requests(store.db) } }, 0);
});
afterAll(() => server.stop(true));

async function connect() {
  const client = new Client({ name: "fleet-control-request-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}mcp`)));
  return client;
}
const body = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
const errorText = (r: unknown) => (r as { isError?: boolean; content: { text: string }[] }).content[0]!.text;
const resolveOnPage = (id: string, b: unknown, origin: string | null = server.url.origin) =>
  fetch(`${server.url}api/requests/${id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(b),
  });

test("the orchestrator asks over MCP, the page answers over REST, the gate opens only for that revision", async () => {
  const orch = await connect();
  body(await orch.callTool({ name: "run_register", arguments: { runId: "run-api", orchestrator: "supervisor", phase: "phase-2" } }));
  const { request } = body(await orch.callTool({ name: "request_create", arguments: {
    runId: "run-api", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Start phase 3?", evidence: ["bun test 51/0"],
  } }));

  const listed = (await (await fetch(`${server.url}api/requests`)).json()) as { requests: { id: string; status: string }[] };
  expect(listed.requests.find((r) => r.id === request.id)?.status).toBe("open");
  expect(body(await orch.callTool({ name: "request_gate", arguments: { runId: "run-api", phase: "phase-2", revision: 1 } })).approved).toBe(false);

  const answered = await resolveOnPage(request.id, { response: "approve", expectedRevision: 1 });
  expect(answered.status).toBe(200);
  expect(((await answered.json()) as { request: { resolvedBy: string } }).request.resolvedBy).toBe("web-ui");

  expect(body(await orch.callTool({ name: "request_gate", arguments: { runId: "run-api", phase: "phase-2", revision: 1 } })).approved).toBe(true);
  expect(body(await orch.callTool({ name: "request_acknowledge", arguments: { requestId: request.id, actor: "supervisor" } })).request.status).toBe("acknowledged");
  await orch.close();
});

test("a second, different answer from the MacBook session conflicts and does not overwrite the page's answer", async () => {
  const client = await connect();
  body(await client.callTool({ name: "run_register", arguments: { runId: "run-race", orchestrator: "supervisor", phase: "phase-1" } }));
  const { request } = body(await client.callTool({ name: "request_create", arguments: { runId: "run-race", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Merge?" } }));
  expect((await resolveOnPage(request.id, { response: "decline", expectedRevision: 1 })).status).toBe(200);
  const late = await client.callTool({ name: "request_resolve", arguments: { requestId: request.id, response: "approve", actor: "macbook-session", expectedRevision: 1 } });
  expect(late.isError).toBe(true);
  expect(errorText(late)).toMatch(/^conflict: .*already answered "decline" by web-ui/);
  const again = await resolveOnPage(request.id, { response: "approve", expectedRevision: 1 });
  expect(again.status).toBe(409);
  await client.close();
});

test("the page cannot answer a stale revision, a foreign origin or without an Origin header", async () => {
  const client = await connect();
  body(await client.callTool({ name: "run_register", arguments: { runId: "run-stale", orchestrator: "supervisor", phase: "phase-1" } }));
  const { request } = body(await client.callTool({ name: "request_create", arguments: { runId: "run-stale", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Ship?" } }));
  expect((await resolveOnPage(request.id, { response: "approve", expectedRevision: 1 }, "http://evil.example")).status).toBe(403);
  expect((await resolveOnPage(request.id, { response: "approve", expectedRevision: 1 }, null)).status).toBe(403);
  const moved = body(await client.callTool({ name: "phase_update", arguments: { runId: "run-stale", actor: "supervisor", expectedRevision: 1, phaseStatus: "fix round", newRevision: true } }));
  expect(moved.staled).toEqual([request.id]);
  const stale = await resolveOnPage(request.id, { response: "approve", expectedRevision: 1 });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { error: { message: string } }).error.message).toMatch(/stale/);
  expect((await resolveOnPage("req-missing", { response: "approve", expectedRevision: 1 })).status).toBe(404);
  await client.close();
});

test("a worker cannot write the phase record over MCP", async () => {
  const client = await connect();
  body(await client.callTool({ name: "run_register", arguments: { runId: "run-owner", orchestrator: "supervisor", phase: "phase-1" } }));
  const r = await client.callTool({ name: "phase_update", arguments: { runId: "run-owner", actor: "worker-api", expectedRevision: 1, phaseStatus: "done", newRevision: false } });
  expect(r.isError).toBe(true);
  expect(errorText(r)).toMatch(/^forbidden:/);
  await client.close();
});

test("request tools are listed next to command tools", async () => {
  const client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["run_register", "phase_update", "request_create", "request_resolve", "request_acknowledge", "request_withdraw", "request_list", "run_list", "request_gate", "request_events"]) {
    expect(names).toContain(n);
  }
  await client.close();
});
