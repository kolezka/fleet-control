// Token roles on the host service: only an operator answers requests, a viewer changes nothing,
// and a tokens line without a role is an agent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Auth, AuthConfigError, parseTokens, tokenLine } from "./auth.ts";
import { Commands } from "./data/commands.ts";
import { Deliverer } from "./application/delivery.ts";
import type { Sender } from "./domain/delivery.ts";
import { Requests } from "./data/requests.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

describe("tokens file roles", () => {
  test("a third column sets the role; a line without one is an agent; an unknown role is refused", () => {
    const auth = new Auth(parseTokens([
      tokenLine("gw", "t-op", "operator"), tokenLine("look", "t-view", "viewer"), tokenLine("orch", "t-old"),
    ].join("\n")));
    expect(auth.check("t-op")).toEqual({ name: "gw", role: "operator" });
    expect(auth.check("t-view")).toEqual({ name: "look", role: "viewer" });
    expect(auth.check("t-old")).toEqual({ name: "orch", role: "agent" });
    expect(() => parseTokens(`${tokenLine("gw", "x")} admin`)).toThrow(AuthConfigError);
    expect(() => parseTokens(`${tokenLine("gw", "x")} operator extra`)).toThrow(AuthConfigError);
  });

  test("a role change on reload makes a principal held by an open socket stale", () => {
    const auth = new Auth(parseTokens(tokenLine("gw", "t", "operator")));
    const held = auth.check("t")!;
    expect(auth.current(held)).toBe(true);
    auth.replace(new Auth(parseTokens(tokenLine("gw", "t", "viewer"))));
    expect(auth.current(held)).toBe(false);
    expect(auth.check("t")?.role).toBe("viewer");
  });
});

describe("service with roles", () => {
  const sent: string[] = [];
  const fakeSend: Sender = async (session, file) => {
    sent.push(await Bun.file(file).text());
    return { exitCode: 0, stdout: `${session}: delivered`, stderr: "" };
  };
  const fleet = { screen: async () => "", status: async () => ({ raw: "", sessions: [] }) };
  const tokens = { op: "tok-operator", agent: "tok-agent", legacy: "tok-legacy", view: "tok-viewer" };
  let server: ReturnType<typeof serve>;
  let requests: Requests;
  let commands: Commands;

  beforeAll(() => {
    const store = new Store();
    commands = new Commands(store.db);
    requests = new Requests(store.db);
    const auth = new Auth(parseTokens([
      tokenLine("gateway", tokens.op, "operator"),
      tokenLine("orch", tokens.agent, "agent"),
      tokenLine("old-orch", tokens.legacy),
      tokenLine("watcher", tokens.view, "viewer"),
    ].join("\n")));
    server = serve({ fleet, store, control: { commands, deliverer: new Deliverer(commands, fakeSend), requests } }, 0, { auth });
  });
  afterAll(() => server.stop(true));

  const url = (p: string) => `${server.url}${p.replace(/^\//, "")}`;
  async function mcp(token: string) {
    const client = new Client({ name: "roles-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url("/mcp")), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  }
  const body = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
  const resolveRest = (token: string, id: string, response: string) => fetch(url(`/api/requests/${id}/resolve`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: server.url.origin },
    body: JSON.stringify({ response, expectedRevision: 1 }),
  });
  async function openRequest(runId: string) {
    const orch = await mcp(tokens.agent);
    body(await orch.callTool({ name: "run_register", arguments: { runId, orchestrator: "x", phase: "p1" } }));
    const { request } = body(await orch.callTool({ name: "request_create", arguments: { runId, origin: "x", expectedRevision: 1, kind: "approval", question: "go?" } }));
    await orch.close();
    return request.id as string;
  }

  test("whoami reports the role", async () => {
    for (const [token, role] of [[tokens.op, "operator"], [tokens.agent, "agent"], [tokens.legacy, "agent"], [tokens.view, "viewer"]] as const) {
      const who = await (await fetch(url("/api/whoami"), { headers: { authorization: `Bearer ${token}` } })).json();
      expect(who.role).toBe(role);
    }
  });

  test("an agent cannot answer a request, on REST or MCP, even the one it asked; an operator can", async () => {
    const id = await openRequest("roles-run");
    for (const token of [tokens.agent, tokens.legacy]) {
      const rest = await resolveRest(token, id, "approve");
      expect(rest.status).toBe(403);
      expect((await rest.json()).error.kind).toBe("forbidden");
      const client = await mcp(token);
      const denied = await client.callTool({ name: "request_resolve", arguments: { requestId: id, response: "approve", actor: "human", expectedRevision: 1 } });
      expect(denied.isError).toBe(true);
      expect(text(denied)).toContain("forbidden");
      await client.close();
    }
    expect(requests.get(id).status).toBe("open");
    const gate = await mcp(tokens.agent);
    expect(body(await gate.callTool({ name: "request_gate", arguments: { runId: "roles-run", phase: "p1", revision: 1 } })).approved).toBe(false);

    const ok = await resolveRest(tokens.op, id, "approve");
    expect(ok.status).toBe(200);
    expect((await ok.json()).request.resolvedBy).toBe("gateway");
    expect(body(await gate.callTool({ name: "request_gate", arguments: { runId: "roles-run", phase: "p1", revision: 1 } })).approved).toBe(true);
    await gate.close();

    const second = await openRequest("roles-run-mcp");
    const op = await mcp(tokens.op);
    const answered = body(await op.callTool({ name: "request_resolve", arguments: { requestId: second, response: "approve", actor: "someone", expectedRevision: 1 } }));
    expect(answered.request.resolvedBy).toBe("gateway");
    await op.close();
  });

  test("a viewer reads everything and changes nothing", async () => {
    for (const p of ["/api/sessions", "/api/commands", "/api/requests", "/api/hosts"]) {
      expect((await fetch(url(p), { headers: { authorization: `Bearer ${tokens.view}` } })).status).toBe(200);
    }
    const before = commands.list().length, sentBefore = sent.length, runsBefore = requests.runs().length;
    const post = await fetch(url("/api/commands"), {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.view}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "roles-view-0001", target: "sup", text: "hello" }),
    });
    expect(post.status).toBe(403);
    expect((await post.json()).error.kind).toBe("forbidden");

    const id = await openRequest("roles-run-view");
    expect((await resolveRest(tokens.view, id, "approve")).status).toBe(403);

    // A queued command the viewer could otherwise deliver, answer or report on.
    const queued = commands.submit({ idempotencyKey: "roles-view-queued", target: "sup", actor: "orch", text: "waiting" }).command;
    const eventsBefore = commands.events(queued.id).length;
    const reqEvents = requests.events(0, 1000).length;
    const client = await mcp(tokens.view);
    // Every MCP tool that writes. Each must be refused with forbidden, whatever state it would act on.
    const writes = [
      ["command_submit", { target: "sup", text: "x", idempotencyKey: "roles-view-0002", actor: "v" }],
      ["command_deliver", { id: queued.id }],
      ["command_respond", { id: queued.id, decision: "accepted", actor: "v", reason: "" }],
      ["command_report", { id: queued.id, status: "running", actor: "v", evidence: "e" }],
      ["run_register", { runId: "roles-view-run", orchestrator: "x", phase: "p1" }],
      ["phase_update", { runId: "roles-run-view", actor: "x", expectedRevision: 1, phaseStatus: "done", newRevision: false }],
      ["request_create", { runId: "roles-run-view", origin: "x", expectedRevision: 1, kind: "approval", question: "again?" }],
      ["request_resolve", { requestId: id, response: "approve", actor: "h", expectedRevision: 1 }],
      ["request_acknowledge", { requestId: id, actor: "h" }],
      ["request_withdraw", { requestId: id, actor: "h", reason: "no" }],
    ] as const;
    const listed = (await client.listTools()).tools.map((t) => t.name);
    for (const [name] of writes) expect(listed).toContain(name);
    for (const [name, args] of writes) {
      const r = await client.callTool({ name, arguments: args });
      // The role refusal itself, not the store's orchestrator check, which would also say forbidden.
      expect({ name, isError: r.isError, text: text(r) }).toEqual({ name, isError: true, text: `forbidden: role viewer may not ${name === "request_resolve" ? "answer requests" : "change anything"}` });
    }
    expect(commands.get(queued.id).status).toBe("queued");
    expect(commands.events(queued.id).length).toBe(eventsBefore);
    expect(requests.events(0, 1000).length).toBe(reqEvents);
    // Reads still work over MCP.
    expect(Array.isArray(body(await client.callTool({ name: "command_list", arguments: {} })).commands)).toBe(true);
    await client.close();

    expect(commands.list().length).toBe(before + 1); // only the queued row made directly in the store
    expect(sent.length).toBe(sentBefore);
    expect(requests.runs().length).toBe(runsBefore + 1); // only the agent's run
    expect(requests.get(id).status).toBe("open");
  });

  test("an agent still queues commands and writes its own run", async () => {
    const res = await fetch(url("/api/commands"), {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.legacy}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "roles-agent-0001", target: "sup", text: "hello" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).command.actor).toBe("old-orch");
  });
});
