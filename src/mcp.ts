// MCP tools over Streamable HTTP, served by the same host service as the web API.
// Stateless: each POST gets a fresh server and transport, all state lives in SQLite.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { CommandError, MAX_TEXT, type Commands } from "./commands.ts";
import type { Deliverer } from "./delivery.ts";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof CommandError ? `${e.kind}: ${e.message}` : `internal error: ${(e as Error).message}` }],
});

export function buildMcpServer(deps: { commands: Commands; deliverer: Deliverer }) {
  const { commands, deliverer } = deps;
  const server = new McpServer({ name: "fleet-control", version: "0.1.0" });

  server.registerTool("command_submit", {
    description:
      "Queue an instruction for one fleet session and try to deliver it with fleet send. " +
      "The result says queued, delivered or delivery_unknown. Delivered only means the text reached the pane; " +
      "it is not acceptance or execution. Reuse the same idempotencyKey when retrying.",
    inputSchema: {
      target: z.string().regex(/^[A-Za-z0-9._-]+$/).describe("Recipient session, e.g. the supervisor"),
      text: z.string().min(1).max(MAX_TEXT),
      idempotencyKey: z.string().min(8).max(200).describe("Stable key for this intent; a retry with the same key returns the original command"),
      actor: z.string().min(1).max(100).describe("Who is asking, e.g. 'macbook-session'"),
    },
  }, async (args) => {
    try {
      const { command, created } = commands.submit(args);
      const after = created ? await deliverer.deliver(command.id) : command;
      return json({ command: after, created, events: commands.events(command.id) });
    } catch (e) { return failure(e); }
  });

  server.registerTool("command_deliver", {
    description: "Retry delivery of a queued command (fleet send refused it before pasting). Does nothing for any other status; delivery_unknown is never retried automatically.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    try { const c = await deliverer.deliver(id); return json({ command: c, events: commands.events(id) }); } catch (e) { return failure(e); }
  });

  server.registerTool("command_get", {
    description: "Read one command with its full status history.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    try { return json({ command: commands.get(id), events: commands.events(id) }); } catch (e) { return failure(e); }
  });

  server.registerTool("command_list", {
    description: "List commands, optionally by status (queued, delivered, delivery_unknown, accepted, rejected, running, completed, failed).",
    inputSchema: { status: z.enum(["queued", "delivering", "delivered", "delivery_unknown", "accepted", "rejected", "running", "completed", "failed"]).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ status }) => json({ commands: commands.list(status) }));

  server.registerTool("command_events", {
    description: "Read command status events after a cursor (seq). Use the last seq you saw to poll for changes.",
    inputSchema: { afterSeq: z.number().int().min(0).default(0) },
    annotations: { readOnlyHint: true },
  }, async ({ afterSeq }) => json({ events: commands.events(undefined, afterSeq) }));

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
    try { return json({ command: commands.transition(id, decision, actor, reason || decision) }); } catch (e) { return failure(e); }
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
    try { return json({ command: commands.transition(id, status, actor, evidence) }); } catch (e) { return failure(e); }
  });

  return server;
}

export async function handleMcp(req: Request, deps: Parameters<typeof buildMcpServer>[0], allowedHosts: string[]): Promise<Response> {
  const server = buildMcpServer(deps);
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
