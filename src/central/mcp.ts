import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CommandError, MAX_TEXT, type CommandStatus } from "../commands.ts";
import { authorize, supervisorIdentity, type Principal } from "./auth.ts";
import type { CentralCommand, CentralCommandInput, CommandListPagination, CommandListScope, CommandPage } from "./commands.ts";
import { RequestError } from "../requests.ts";
import type { CentralRequests } from "./requests.ts";
import type { SupervisorIdentityRegistry } from "./identity-registry.ts";
import type { SupervisorCommandScope, SupervisorReadGuard } from "./commands.ts";
import type { TransactionSQL } from "bun";

export type CentralMcpCommands = {
  submit(input: CentralCommandInput): Promise<{ command: CentralCommand; created: boolean }>;
  get(id: string): Promise<CentralCommand>;
  list(status?: CommandStatus, scope?: CommandListScope, pagination?: CommandListPagination): Promise<CommandPage>;
  transition(id: string, to: CommandStatus, actor: string, detail: string): Promise<CentralCommand>;
  transitionScoped?(id: string, to: "accepted" | "rejected" | "running" | "completed" | "failed", actor: string, detail: string, scope: SupervisorCommandScope, guard: SupervisorReadGuard): Promise<CentralCommand>;
  getScoped?(id: string, scope: SupervisorCommandScope, guard: SupervisorReadGuard): Promise<CentralCommand>;
  listScoped?(status: CommandStatus | undefined, scope: SupervisorCommandScope, guard: SupervisorReadGuard, pagination?: CommandListPagination): Promise<CommandPage>;
};

// Same finite bound as the store's own cursor decoder. A scoped cursor embeds host and target (up to 256 chars each),
// so it can exceed 512 chars. Measured: 1484 chars for a 256 CJK host plus 256 char target, about 2.1K if both were CJK; 8192 leaves room.
const MAX_COMMAND_CURSOR = 8192;
const statuses = ["queued", "delivering", "delivered", "delivery_unknown", "claimed", "accepted", "rejected", "running", "completed", "failed"] as const;
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
export function buildCentralMcpServer(deps: { commands: CentralMcpCommands; requests?: CentralRequests; identities?: Pick<SupervisorIdentityRegistry, "lockActive"> }, principal: Principal, options: { commandListLimit?: number } = {}) {
  if (!principal || !["operator", "supervisor"].includes(principal.role) || !principal.name?.trim()) throw new Error("MCP access denied");
  if (principal.role === "supervisor" && (typeof principal.principalId !== "string" || !principal.principalId.trim() || !authorize(principal, "supervisor", { hostId: principal.hostId, session: principal.session }))) throw new Error("MCP access denied");
  principal = { ...principal };
  const identity = principal.role === "supervisor" ? supervisorIdentity(principal) : undefined;
  const guard: SupervisorReadGuard = async (tx) => {
    if (!identity || !deps.identities || await deps.identities.lockActive(tx, identity) !== true) throw new Error("access denied");
    return true;
  };
  const { commands } = deps;
  const server = new McpServer({ name: "fleet-control-central", version: "0.1.0" });
  const scoped = async (id: string) => {
    if (principal.role === "operator") return commands.get(id);
    if (!identity || !commands.getScoped) throw new Error("access denied");
    return commands.getScoped(id, { hostId: identity.hostId, session: identity.session }, guard);
  };

  if (principal.role === "operator") {
    server.registerTool("command_submit", {
      description: "Queue an instruction for a host and session. Queued does not mean delivered or accepted.",
      inputSchema: { hostId: z.string().min(1), target: z.string().min(1), text: z.string().min(1).max(MAX_TEXT), idempotencyKey: z.string().min(1).max(200) },
    }, async (args) => attempt(async () => commands.submit({ ...args, actor: principal.name })));
  }
  server.registerTool("command_get", {
    description: "Read one command within your scope.", inputSchema: { id: z.string().min(1) }, annotations: { readOnlyHint: true },
  }, async ({ id }) => attempt(async () => ({ command: await scoped(id) }), principal.role === "operator" && options.commandListLimit !== undefined));
  server.registerTool("command_list", {
    description: "List commands within your scope, ordered oldest first. Pass nextCursor to continue.", inputSchema: { status: z.enum(statuses).optional(), limit: options.commandListLimit === undefined ? z.number().int().min(1).max(1000).optional() : z.number().int().min(1).max(options.commandListLimit).default(options.commandListLimit), cursor: z.string().min(1).max(MAX_COMMAND_CURSOR).optional() }, annotations: { readOnlyHint: true },
  }, async ({ status, limit, cursor }) => attempt(async () => {
    const page = { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) };
    if (principal.role === "operator") return commands.list(status, undefined, page);
    if (!identity || !commands.listScoped) throw new Error("access denied");
    return commands.listScoped(status, { hostId: identity.hostId, session: identity.session }, guard, page);
  }, principal.role === "operator" && options.commandListLimit !== undefined));

  if (principal.role === "supervisor") {
    server.registerTool("command_respond", {
      description: "Accept or reject a command addressed to this supervisor.",
      inputSchema: { id: z.string().min(1), decision: z.enum(["accepted", "rejected"]), reason: z.string().max(1000).default("") },
    }, async ({ id, decision, reason }) => attempt(async () => {
      if (!commands.transitionScoped || !identity) throw new Error("access denied");
      return { command: await commands.transitionScoped(id, decision, identity.name, reason || decision, { hostId: identity.hostId, session: identity.session }, guard) };
    }));
    server.registerTool("command_report", {
      description: "Report execution of an accepted command with evidence.",
      inputSchema: { id: z.string().min(1), status: z.enum(["running", "completed", "failed"]), evidence: z.string().min(1).max(4000) },
    }, async ({ id, status, evidence }) => attempt(async () => {
      if (!commands.transitionScoped || !identity) throw new Error("access denied");
      return { command: await commands.transitionScoped(id, status, identity.name, evidence, { hostId: identity.hostId, session: identity.session }, guard) };
    }));
  }
  if (deps.requests) registerRequestTools(server, deps.requests, principal, guard);
  return server;
}

// The embedded newline cannot occur in a valid authenticated principal name.
const ownerPrefix = "central-supervisor\n";
const displayOwner = (owner: string) => {
  if (!owner.startsWith(ownerPrefix)) return owner;
  try {
    const parts: unknown = JSON.parse(owner.slice(ownerPrefix.length));
    return Array.isArray(parts) && parts.length === 4 && parts.every((part) => typeof part === "string") ? parts[0] as string : owner;
  } catch { return owner; }
};
const displayRun = <T extends { orchestrator: string }>(run: T): T => ({ ...run, orchestrator: displayOwner(run.orchestrator) });
const displayRequest = <T extends { origin: string }>(request: T): T => ({ ...request, origin: displayOwner(request.origin) });

function registerRequestTools(server: McpServer, requests: CentralRequests, principal: Principal, guard: SupervisorReadGuard) {
  if (principal.role === "operator") {
    server.registerTool("request_list", {
      description: "List runs and requests, optionally filtered by run and status.",
      inputSchema: { runId: z.string().min(1).optional(), status: z.enum(["open", "resolved", "acknowledged", "stale", "withdrawn"]).optional(), limit: z.number().int().min(1).max(1000).optional(), cursor: z.string().optional() },
      annotations: { readOnlyHint: true },
    }, async (filter) => attempt(async () => { const page = await requests.list(filter); return { runs: (await requests.runs()).map(displayRun), requests: page.requests.map(displayRequest), nextCursor: page.nextCursor }; }));
    server.registerTool("request_get", {
      description: "Read one request.", inputSchema: { requestId: z.string().min(1) }, annotations: { readOnlyHint: true },
    }, async ({ requestId }) => attempt(async () => ({ request: displayRequest(await requests.get(requestId)) })));
    server.registerTool("request_resolve", {
      description: "Relay a human answer, bound to the request revision. Never answer on the human's behalf.",
      inputSchema: { requestId: z.string().min(1), response: z.string().min(1).max(100), expectedRevision: z.number().int().min(1), note: z.string().max(1000).optional() },
    }, async (args) => attempt(async () => ({ request: displayRequest(await requests.resolve({ ...args, actor: principal.name })) })));
    return;
  }
  if (principal.role !== "supervisor") return;
  const mutation = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (error) {
      if (error instanceof RequestError && (error.kind === "not_found" || error.kind === "forbidden")) throw new Error("access denied");
      throw error;
    }
  };
  const requestGuard = async (tx: import("bun").SQL) => { await guard(tx as unknown as TransactionSQL, { hostId: principal.hostId, session: principal.session }); };
  const owner = ownerPrefix + JSON.stringify([principal.name, principal.principalId, principal.hostId, principal.session]);
  server.registerTool("run_register", {
    description: "Register a run owned by the authenticated supervisor.",
    inputSchema: { runId: z.string().min(1).max(200), phase: z.string().min(1).max(200) },
  }, async (args) => attempt(async () => ({ run: displayRun(await mutation(() => requests.registerRun({ ...args, orchestrator: owner }, requestGuard))) })));
  server.registerTool("phase_update", {
    description: "Update your run's phase and revision. New revisions stale open requests.",
    inputSchema: { runId: z.string().min(1), expectedRevision: z.number().int().min(1), phase: z.string().max(200).optional(), phaseStatus: z.string().min(1).max(500), newRevision: z.boolean() },
  }, async (args) => attempt(async () => { const updated = await mutation(() => requests.updatePhase({ ...args, actor: owner }, requestGuard)); return { ...updated, run: displayRun(updated.run) }; }));
  server.registerTool("request_create", {
    description: "Create a request for your run's current phase and revision.",
    inputSchema: { runId: z.string().min(1), expectedRevision: z.number().int().min(1), kind: z.enum(["approval", "clarification", "scope_change", "blocker"]), question: z.string().min(1).max(2000), proposedAction: z.string().max(2000).optional(), scope: z.string().max(1000).optional(), evidence: z.array(z.string().max(500)).max(20).optional(), allowedResponses: z.array(z.string().min(1).max(100)).max(10).optional(), blocking: z.boolean().optional() },
  }, async (args) => attempt(async () => { return { request: displayRequest(await mutation(() => requests.create({ ...args, origin: owner }, requestGuard))) }; }));
  server.registerTool("request_acknowledge", {
    description: "Acknowledge an answer on your run; this does not start the next phase.", inputSchema: { requestId: z.string().min(1) },
  }, async (args) => attempt(async () => { return { request: displayRequest(await mutation(() => requests.acknowledge({ ...args, actor: owner }, requestGuard))) }; }));
  server.registerTool("request_withdraw", {
    description: "Withdraw an open request on your run.", inputSchema: { requestId: z.string().min(1), reason: z.string().min(1).max(500) },
  }, async (args) => attempt(async () => { return { request: displayRequest(await mutation(() => requests.withdraw({ ...args, actor: owner }, requestGuard))) }; }));
  server.registerTool("request_gate", {
    description: "Check the approval gate based on recorded responses for your run's exact phase and revision. The result is not proof of a human decision and is not authorization to execute.",
    inputSchema: { runId: z.string().min(1), phase: z.string().min(1), revision: z.number().int().min(1) }, annotations: { readOnlyHint: true },
  }, async ({ runId, phase, revision }) => attempt(async () => mutation(() => requests.gateScoped(runId, phase, revision, owner, requestGuard))));
}
