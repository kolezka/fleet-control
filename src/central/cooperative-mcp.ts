import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CommandError } from "../domain/commands.ts";
import type { Principal, IncarnationCredential } from "./domain/identity.ts";
import type { CooperativeClaims } from "./data/cooperative-claims.ts";
import type { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";

// The caller must authenticate the principal and obtain the credential out of band.
// This server must not be mounted alongside legacy supervisor mutation routes.
export function buildCooperativeMcpServer(
  deps: { claims: CooperativeClaims; lifecycle: CooperativeLifecycle },
  principal: Principal,
  credential: IncarnationCredential,
  // Other secrets the caller holds for this request, such as the supervisor's own bearer; input containing one is refused.
  options: { refuse?: readonly string[] } = {},
) {
  const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
  if (!principal || principal.role !== "supervisor" || ![principal.principalId, principal.name, principal.hostId, principal.session].every(valid)
    || !credential || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(credential.incarnationId)
    || !/^[A-Za-z0-9_-]{43}$/.test(credential.token)) throw new Error("MCP access denied");
  const identity = { ...principal };
  const incarnation = { ...credential };
  const refused = [incarnation.token, ...(options.refuse ?? []).filter((secret) => typeof secret === "string" && secret.length >= 16)];
  const sensitive = (value: string) => refused.some((secret) => value.includes(secret));
  const server = new McpServer({ name: "fleet-control-cooperative", version: "0.1.0" });
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      const text = JSON.stringify(await fn());
      if (text.includes(incarnation.token)) throw new Error("sensitive response");
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      const message = error instanceof CommandError && error.kind === "invalid" ? "invalid request"
        : error instanceof CommandError && error.kind === "conflict" ? "conflict" : "request failed";
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  };
  server.registerTool("cooperative_claim", {
    description: "Atomically reserve one eligible queued command for this supervisor. Reuse requestId to retry, including an empty result. A claim is not acceptance or execution.",
    inputSchema: { requestId: z.string().min(1).max(256) },
  }, async ({ requestId }) => attempt(async () => {
    if (sensitive(requestId)) throw new Error("sensitive request");
    return { command: await deps.claims.claim(identity, incarnation, requestId, (command) => {
      const response = JSON.stringify({ command });
      return !response.includes(incarnation.token) && !response.includes(incarnation.incarnationId);
    }) };
  }));
  server.registerTool("cooperative_report", {
    description: "Report a lifecycle transition for a command claimed by this incarnation. Reuse requestId only for the same report. Reports do not change the frozen command row.",
    inputSchema: { commandId: z.string().min(1).max(256), requestId: z.string().min(1).max(256), status: z.enum(["accepted", "rejected", "running", "completed", "failed"]), detail: z.string().max(65536) },
  }, async ({ commandId, requestId, status, detail }) => attempt(async () => {
    if ([commandId, requestId, detail].some(sensitive)) throw new Error("sensitive request");
    return { event: await deps.lifecycle.report(identity, incarnation, commandId, requestId, status, detail) };
  }));
  return server;
}
