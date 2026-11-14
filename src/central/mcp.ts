import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CommandError, MAX_TEXT } from "../domain/commands.ts";
import { authorize, type Principal } from "./domain/identity.ts";
import { centralCommandStatuses } from "./domain/commands.ts";
import { RequestError } from "../domain/requests.ts";
import type { CentralRequests } from "./data/requests.ts";
import type { SupervisorIdentityRegistry } from "./data/identity-registry.ts";
import type { IdentityFence } from "./data/identity-fence.ts";
import { commandAccess, type CentralCommandStore } from "./application/commands.ts";
import { operatorRequests, supervisorRequests } from "./application/requests.ts";

// Same finite bound as the store's own cursor decoder. A scoped cursor embeds host and target (up to 256 chars each),
// so it can exceed 512 chars. Measured: 1484 chars for a 256 CJK host plus 256 char target, about 2.1K if both were CJK; 8192 leaves room.
const MAX_COMMAND_CURSOR = 8192;
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const MAX_COOPERATIVE_READ_RESPONSE_BYTES = 2 * 1024 * 1024;
// Each UTF-16 code unit in an accepted request ID can require six JSON bytes.
const MAX_RPC_ID = "\u0000".repeat(256);
const readResult = (value: unknown) => {
  const result = json(value);
  const envelope = JSON.stringify({ jsonrpc: "2.0", id: MAX_RPC_ID, result });
  return Buffer.byteLength(envelope, "utf8") <= MAX_COOPERATIVE_READ_RESPONSE_BYTES
    ? result
    : { isError: true, content: [{ type: "text" as const, text: "response exceeds read budget" }] };
};
const attempt = async (fn: () => Promise<unknown>, boundedRead = false) => {
  try { const value = await fn(); return boundedRead ? readResult(value) : json(value); }
  catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof RequestError && error.kind === "forbidden" ? "request failed" : error instanceof CommandError || error instanceof RequestError ? `${error.kind}: ${error.message}` : "request failed" }] };
  }
};

// The principal must come from authentication, never from MCP arguments.
export function buildCentralMcpServer(deps: { commands: CentralCommandStore; requests?: CentralRequests; identities?: Pick<SupervisorIdentityRegistry, "lockActive"> }, principal: Principal, options: { commandListLimit?: number } = {}) {
  if (!principal || !["operator", "supervisor"].includes(principal.role) || !principal.name?.trim()) throw new Error("MCP access denied");
  if (principal.role === "supervisor" && (typeof principal.principalId !== "string" || !principal.principalId.trim() || !authorize(principal, "supervisor", { hostId: principal.hostId, session: principal.session }))) throw new Error("MCP access denied");
  principal = { ...principal };
  const access = commandAccess(deps, principal);
  const server = new McpServer({ name: "fleet-control-central", version: "0.1.0" });

  if (principal.role === "operator") {
    server.registerTool("command_submit", {
      description: "Queue an instruction for a host and session. Queued does not mean delivered or accepted.",
      inputSchema: { hostId: z.string().min(1), target: z.string().min(1), text: z.string().min(1).max(MAX_TEXT), idempotencyKey: z.string().min(1).max(200) },
    }, async (args) => attempt(async () => access.submit(args)));
  }
  server.registerTool("command_get", {
    description: "Read one command within your scope.", inputSchema: { id: z.string().min(1) }, annotations: { readOnlyHint: true },
  }, async ({ id }) => attempt(async () => ({ command: await access.read(id) }), principal.role === "operator" && options.commandListLimit !== undefined));
  server.registerTool("command_list", {
    description: "List commands within your scope, ordered oldest first. Pass nextCursor to continue.", inputSchema: { status: z.enum(centralCommandStatuses).optional(), limit: options.commandListLimit === undefined ? z.number().int().min(1).max(1000).optional() : z.number().int().min(1).max(options.commandListLimit).default(options.commandListLimit), cursor: z.string().min(1).max(MAX_COMMAND_CURSOR).optional() }, annotations: { readOnlyHint: true },
  }, async ({ status, limit, cursor }) => attempt(async () => access.list(status, { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) }), principal.role === "operator" && options.commandListLimit !== undefined));

  if (principal.role === "supervisor") {
    server.registerTool("command_respond", {
      description: "Accept or reject a command addressed to this supervisor.",
      inputSchema: { id: z.string().min(1), decision: z.enum(["accepted", "rejected"]), reason: z.string().max(1000).default("") },
    }, async ({ id, decision, reason }) => attempt(async () => ({ command: await access.respond(id, decision, reason) })));
    server.registerTool("command_report", {
      description: "Report execution of an accepted command with evidence.",
      inputSchema: { id: z.string().min(1), status: z.enum(["running", "completed", "failed"]), evidence: z.string().min(1).max(4000) },
    }, async ({ id, status, evidence }) => attempt(async () => ({ command: await access.report(id, status, evidence) })));
  }
  if (deps.requests) registerRequestTools(server, deps.requests, principal, access.fence);
  return server;
}

function registerRequestTools(server: McpServer, requests: CentralRequests, principal: Principal, fence: IdentityFence | undefined) {
  if (principal.role === "operator") {
    const operator = operatorRequests(requests, principal);
    server.registerTool("request_list", {
      description: "List runs and requests, optionally filtered by run and status.",
      inputSchema: { runId: z.string().min(1).optional(), status: z.enum(["open", "resolved", "acknowledged", "stale", "withdrawn"]).optional(), limit: z.number().int().min(1).max(1000).optional(), cursor: z.string().optional() },
      annotations: { readOnlyHint: true },
    }, async (filter) => attempt(async () => operator.list(filter)));
    server.registerTool("request_get", {
      description: "Read one request.", inputSchema: { requestId: z.string().min(1) }, annotations: { readOnlyHint: true },
    }, async ({ requestId }) => attempt(async () => ({ request: await operator.get(requestId) })));
    server.registerTool("request_resolve", {
      description: "Relay a human answer, bound to the request revision. Never answer on the human's behalf.",
      inputSchema: { requestId: z.string().min(1), response: z.string().min(1).max(100), expectedRevision: z.number().int().min(1), note: z.string().max(1000).optional() },
    }, async (args) => attempt(async () => ({ request: await operator.resolve(args) })));
    return;
  }
  if (principal.role !== "supervisor" || !fence) return;
  const supervisor = supervisorRequests(requests, principal, fence.requests);
  server.registerTool("run_register", {
    description: "Register a run owned by the authenticated supervisor.",
    inputSchema: { runId: z.string().min(1).max(200), phase: z.string().min(1).max(200) },
  }, async (args) => attempt(async () => ({ run: await supervisor.registerRun(args) })));
  server.registerTool("phase_update", {
    description: "Update your run's phase and revision. New revisions stale open requests.",
    inputSchema: { runId: z.string().min(1), expectedRevision: z.number().int().min(1), phase: z.string().max(200).optional(), phaseStatus: z.string().min(1).max(500), newRevision: z.boolean() },
  }, async (args) => attempt(async () => supervisor.updatePhase(args)));
  server.registerTool("request_create", {
    description: "Create a request for your run's current phase and revision.",
    inputSchema: { runId: z.string().min(1), expectedRevision: z.number().int().min(1), kind: z.enum(["approval", "clarification", "scope_change", "blocker"]), question: z.string().min(1).max(2000), proposedAction: z.string().max(2000).optional(), scope: z.string().max(1000).optional(), evidence: z.array(z.string().max(500)).max(20).optional(), allowedResponses: z.array(z.string().min(1).max(100)).max(10).optional(), blocking: z.boolean().optional() },
  }, async (args) => attempt(async () => ({ request: await supervisor.create(args) })));
  server.registerTool("request_acknowledge", {
    description: "Acknowledge an answer on your run; this does not start the next phase.", inputSchema: { requestId: z.string().min(1) },
  }, async (args) => attempt(async () => ({ request: await supervisor.acknowledge(args) })));
  server.registerTool("request_withdraw", {
    description: "Withdraw an open request on your run.", inputSchema: { requestId: z.string().min(1), reason: z.string().min(1).max(500) },
  }, async (args) => attempt(async () => ({ request: await supervisor.withdraw(args) })));
  server.registerTool("request_gate", {
    description: "Check the approval gate based on recorded responses for your run's exact phase and revision. The result is not proof of a human decision and is not authorization to execute.",
    inputSchema: { runId: z.string().min(1), phase: z.string().min(1), revision: z.number().int().min(1) }, annotations: { readOnlyHint: true },
  }, async ({ runId, phase, revision }) => attempt(async () => supervisor.gate(runId, phase, revision)));
}
