import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CommandError, type CommandStatus } from "../domain/commands.ts";
import { type CentralAuth } from "./auth.ts";
import { authorize, supervisorIdentity, type Principal, type SupervisorIdentityLookup } from "./domain/identity.ts";
import { centralCommandStatuses, parseCommandSubmission } from "./domain/commands.ts";
import { readBoundedBody, readBoundedJson } from "./http-body.ts";
import { buildCentralMcpServer } from "./mcp.ts";
import { commandAccess, type CentralCommandStore } from "./application/commands.ts";
import type { CentralRequests } from "./data/requests.ts";
import type { SupervisorIdentityRegistry } from "./data/identity-registry.ts";

const MAX_BODY = 32 * 1024;
type Env = { Variables: { principal: Principal } };

export function createCentralApp(deps: { auth: CentralAuth; commands: CentralCommandStore; identities: SupervisorIdentityLookup & Partial<Pick<SupervisorIdentityRegistry, "lockActive">>; requests?: CentralRequests; allowedOrigins?: readonly string[]; listHosts?: () => { hostId: string; sessions: string[] | null }[] }) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    const principal = deps.auth.authenticate(c.req.raw);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.role === "supervisor") {
      try {
        if (await deps.identities.matches(supervisorIdentity(principal)) !== true) return c.json({ error: "unauthorized" }, 401);
      } catch { return c.json({ error: "unauthorized" }, 401); }
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && !deps.allowedOrigins?.includes(origin)) return c.json({ error: "unsafe origin" }, 403);
    c.set("principal", principal);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof CommandError) return c.json({ error: error.message }, error.kind === "not_found" ? 404 : error.kind === "conflict" ? 409 : 400);
    return c.json({ error: "internal error" }, 500);
  });
  app.use("/api/*", async (c, next) => {
    if (!authorize(c.get("principal"), "operator")) return c.json({ error: "forbidden" }, 403);
    await next();
  });
  app.get("/api/hosts", (c) => c.json({ hosts: deps.listHosts?.() ?? [] }, 200, { "Cache-Control": "no-store" }));
  app.post("/api/commands", async (c) => {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "expected JSON" }, 415);
    let input: unknown;
    try { input = await readBoundedJson(c.req.raw, MAX_BODY); }
    catch (error) { return c.json({ error: error instanceof RangeError ? "body too large" : "invalid JSON" }, error instanceof RangeError ? 413 : 400); }
    const submission = parseCommandSubmission(input);
    if (!submission) return c.json({ error: "invalid command" }, 400);
    const result = await commandAccess({ commands: deps.commands }, c.get("principal")).submit(submission);
    return c.json(result, result.created ? 201 : 200);
  });
  app.get("/api/commands", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !(centralCommandStatuses as readonly string[]).includes(status)) return c.json({ error: "invalid status" }, 400);
    const limitText = c.req.query("limit");
    if (limitText !== undefined && (!/^[1-9]\d*$/.test(limitText) || Number(limitText) > 1000)) return c.json({ error: "invalid limit" }, 400);
    const hostId = c.req.query("hostId");
    const target = c.req.query("target");
    if ((hostId !== undefined && (!hostId.trim() || hostId.length > 256)) || (target !== undefined && (!target.trim() || target.length > 256))) return c.json({ error: "invalid scope" }, 400);
    return c.json(await commandAccess({ commands: deps.commands }, c.get("principal")).list(status as CommandStatus | undefined, { limit: limitText === undefined ? undefined : Number(limitText), cursor: c.req.query("cursor") }, { hostId, target }));
  });
  app.get("/api/commands/:id", async (c) => c.json({ command: await commandAccess({ commands: deps.commands }, c.get("principal")).read(c.req.param("id")) }));
  app.all("/mcp", async (c) => {
    const principal = c.get("principal");
    if (principal.role !== "operator" && principal.role !== "supervisor") return c.json({ error: "forbidden" }, 403);
    let request = c.req.raw;
    if (request.method === "POST") {
      let body: Uint8Array<ArrayBuffer>;
      try { body = await readBoundedBody(request, MAX_BODY); } catch { return c.json({ error: "body too large" }, 413); }
      try { new TextDecoder("utf-8", { fatal: true }).decode(body); }
      catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
      request = new Request(request.url, { method: request.method, headers: request.headers, body });
    }
    const identities = typeof deps.identities.lockActive === "function" ? { lockActive: deps.identities.lockActive.bind(deps.identities) } : undefined;
    const server = buildCentralMcpServer({ commands: deps.commands, requests: deps.requests, identities }, principal);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { return await transport.handleRequest(request); } finally { await server.close(); }
  });
  return app;
}

// A remote listener is permitted only when the caller explicitly supplies TLS.
export function assertSafeCentralBind(hostname: string, tls: unknown): void {
  if (!hostname || (!(["127.0.0.1", "::1", "localhost"].includes(hostname)) && !tls)) throw new Error("non-loopback central bind requires TLS");
}
