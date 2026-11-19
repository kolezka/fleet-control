// MCP tools over Streamable HTTP, served by the same host service as the web API.
// Stateless: each POST gets a fresh server and transport, all state lives in SQLite.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { CommandError, MAX_TEXT } from "./domain/commands.ts";
import { commandUseCases, EVENT_PAGE, MAX_EVENT_PAGE, MAX_PAGE, PAGE } from "./application/commands.ts";
import { requestUseCases } from "./application/requests.ts";
import { RequestError } from "./domain/requests.ts";
import { RoleError, type Caller } from "./domain/roles.ts";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof CommandError || e instanceof RequestError || e instanceof RoleError ? `${e.kind}: ${e.message}` : `internal error: ${(e as Error).message}` }],
});
// A full page means more events may follow: poll again from the last seq.
const eventPage = <E extends { seq: number }>(events: E[], limit: number) =>
  ({ events, ...(events.length === limit ? { nextAfterSeq: events.at(-1)!.seq } : {}) });
const eventInput = {
  afterSeq: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(MAX_EVENT_PAGE).default(EVENT_PAGE),
};
const pageInput = {
  limit: z.number().int().min(1).max(MAX_PAGE).default(PAGE),
  cursor: z.string().max(4096).optional(),
};
const attempt = async (f: () => unknown) => { try { return json(await f()); } catch (e) { return failure(e); } };

// What the tools and the web API act on. The stores and the deliverer are built by the entry point.
export type ControlDeps = Parameters<typeof commandUseCases>[0] & { requests?: Parameters<typeof requestUseCases>[0] };

// With auth, `principal` is the authenticated caller and replaces any self-declared actor.
export function buildMcpServer(deps: ControlDeps, principal?: Caller) {
  const queue = commandUseCases(deps, principal);
  const server = new McpServer({ name: "fleet-control", version: "0.1.0" });

  server.registerTool("command_submit", {
    description:
      "Queue an instruction for one fleet session and try to deliver it with fleet send. " +
      "The result says queued, delivered or delivery_unknown. Delivered is a sender report, not proof the full message reached the pane, " +
      "nor acceptance or execution. Reuse the same idempotencyKey when retrying.",
    inputSchema: {
      target: z.string().regex(/^[A-Za-z0-9._-]+$/).describe("Recipient session, e.g. the supervisor"),
      text: z.string().min(1).max(MAX_TEXT),
      idempotencyKey: z.string().min(8).max(200).describe("Stable key for this intent; a retry with the same key returns the original command"),
      actor: z.string().min(1).max(100).describe("Who is asking, e.g. 'macbook-session'"),
    },
  }, async (args) => {
    try { return json(await queue.submit(args)); } catch (e) { return failure(e); }
  });

  server.registerTool("command_deliver", {
    description: "Attempt delivery of a queued command. Other statuses are unchanged; investigate delivery_unknown rather than retrying it.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    try { return json(await queue.deliver(id)); } catch (e) { return failure(e); }
  });

  server.registerTool("command_get", {
    description: "Read one command with its full status history.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    try { return json(queue.read(id)); } catch (e) { return failure(e); }
  });

  server.registerTool("command_list", {
    description: "List commands oldest first, optionally by status, at most limit (default 100, max 1000). Pass nextCursor back as cursor with the same status for the next page.",
    inputSchema: { status: z.enum(["queued", "delivering", "delivered", "delivery_unknown", "accepted", "rejected", "running", "completed", "failed"]).optional(), ...pageInput },
    annotations: { readOnlyHint: true },
  }, async (a) => attempt(() => queue.page(a)));

  server.registerTool("command_events", {
    description: "Read command status events after a cursor (seq), oldest first, at most limit (default 100, max 1000). nextAfterSeq is set when the page is full; poll again from it.",
    inputSchema: eventInput,
    annotations: { readOnlyHint: true },
  }, async ({ afterSeq, limit }) => json(eventPage(queue.eventsAfter(afterSeq, limit), limit)));

  server.registerTool("command_respond", {
    description:
      "Supervisor's explicit answer to a delivered command: accept or reject it. Only the recipient session should call this. " +
      "Accepting is not execution; report progress with command_report.",
    inputSchema: {
      id: z.string(),
      decision: z.enum(["accepted", "rejected"]),
      actor: z.string().min(1).max(100),
      reason: z.string().max(1000).default(""),
    },
  }, async ({ id, decision, actor, reason }) => {
    try { return json({ command: queue.respond(id, decision, actor, reason) }); } catch (e) { return failure(e); }
  });

  server.registerTool("command_report", {
    description: "Supervisor reports execution of an accepted command: running, completed or failed, with evidence (test output, commit, path).",
    inputSchema: {
      id: z.string(),
      status: z.enum(["running", "completed", "failed"]),
      actor: z.string().min(1).max(100),
      evidence: z.string().min(1).max(4000),
    },
  }, async ({ id, status, actor, evidence }) => {
    try { return json({ command: queue.report(id, status, actor, evidence) }); } catch (e) { return failure(e); }
  });

  if (deps.requests) registerRequestTools(server, requestUseCases(deps.requests, principal));
  return server;
}

function registerRequestTools(server: McpServer, requests: ReturnType<typeof requestUseCases>) {
  const actor = z.string().min(1).max(100);
  server.registerTool("run_register", {
    description: "Orchestrator: register a run once. The orchestrator named here is the only writer of its phase record.",
    inputSchema: { runId: z.string().min(1).max(200), orchestrator: actor, phase: z.string().min(1).max(200) },
  }, async (a) => attempt(() => ({ run: requests.registerRun(a) })));

  server.registerTool("phase_update", {
    description: "Orchestrator: update the phase record. Pass expectedRevision. Set newRevision when the work changed (fix round, new commit); " +
      "that makes every open request for the old revision stale. Changing phase always starts a new revision.",
    inputSchema: { runId: z.string(), actor, expectedRevision: z.number().int().min(1), phase: z.string().max(200).optional(), phaseStatus: z.string().min(1).max(500), newRevision: z.boolean() },
  }, async (a) => attempt(() => requests.updatePhase(a)));

  server.registerTool("request_create", {
    description: "Orchestrator: ask the human for approval, clarification, a scope change or help with a blocker, bound to the run's current phase and revision.",
    inputSchema: {
      runId: z.string(), origin: actor, expectedRevision: z.number().int().min(1),
      kind: z.enum(["approval", "clarification", "scope_change", "blocker"]), question: z.string().min(1).max(2000),
      proposedAction: z.string().max(2000).optional(), scope: z.string().max(1000).optional(),
      evidence: z.array(z.string().max(500)).max(20).optional(), allowedResponses: z.array(z.string().min(1).max(100)).max(10).optional(),
      blocking: z.boolean().optional(),
    },
  }, async (a) => attempt(() => ({ request: requests.create(a) })));

  server.registerTool("request_resolve", {
    description: "Relay a real human answer to one request. Only call this with an answer the user gave you; never answer on their behalf. " +
      "expectedRevision must match the request's revision. A different earlier answer makes this a conflict.",
    inputSchema: { requestId: z.string(), response: z.string().min(1).max(100), actor, expectedRevision: z.number().int().min(1), note: z.string().max(1000).optional() },
  }, async (a) => attempt(() => ({ request: requests.resolve(a) })));

  server.registerTool("request_acknowledge", {
    description: "Orchestrator: confirm you read the answer. This does not mean the next phase started; report that with phase_update.",
    inputSchema: { requestId: z.string(), actor },
  }, async (a) => attempt(() => ({ request: requests.acknowledge(a) })));

  server.registerTool("request_withdraw", {
    description: "Orchestrator: withdraw an open request that is no longer needed.",
    inputSchema: { requestId: z.string(), actor, reason: z.string().min(1).max(500) },
  }, async (a) => attempt(() => ({ request: requests.withdraw(a) })));

  server.registerTool("request_list", {
    description: "List requests oldest first, optionally for one run and status (open, resolved, acknowledged, stale, withdrawn), at most limit (default 100, max 1000), with the runs those requests belong to. Pass nextCursor back as cursor with the same filter. Use run_list for every run.",
    inputSchema: { runId: z.string().optional(), status: z.enum(["open", "resolved", "acknowledged", "stale", "withdrawn"]).optional(), ...pageInput },
    annotations: { readOnlyHint: true },
  }, async (a) => attempt(() => requests.page(a)));

  server.registerTool("run_list", {
    description: "List every run in ID order, at most limit (default 100, max 1000). Pass nextCursor back as cursor for the next page.",
    inputSchema: pageInput,
    annotations: { readOnlyHint: true },
  }, async (a) => attempt(() => requests.runPage(a)));

  server.registerTool("request_gate", {
    description: "Report the recorded approval response for this run, phase and revision. This is not proof of human approval and does not authorize execution.",
    inputSchema: { runId: z.string(), phase: z.string(), revision: z.number().int().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ runId, phase, revision }) => attempt(() => requests.gate(runId, phase, revision)));

  server.registerTool("request_events", {
    description: "Request and phase events after a cursor (seq), oldest first, at most limit (default 100, max 1000). nextAfterSeq is set when the page is full; poll again from it.",
    inputSchema: eventInput,
    annotations: { readOnlyHint: true },
  }, async ({ afterSeq, limit }) => json(eventPage(requests.eventsAfter(afterSeq, limit), limit)));
}

export async function handleMcp(req: Request, deps: ControlDeps, allowedHosts: string[], principal?: Caller): Promise<Response> {
  const server = buildMcpServer(deps, principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Tool handlers have finished once the JSON response exists.
    await server.close();
  }
}
