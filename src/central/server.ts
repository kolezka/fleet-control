import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CommandError, MAX_TEXT, type CommandStatus } from "../commands.ts";
import { authorize, supervisorIdentity, type CentralAuth, type Principal, type SupervisorIdentityLookup } from "./auth.ts";
import { buildCentralMcpServer, type CentralMcpCommands } from "./mcp.ts";
import type { CentralRequests } from "./requests.ts";
import type { SupervisorIdentityRegistry } from "./identity-registry.ts";

const MAX_BODY = 32 * 1024;
const statuses: CommandStatus[] = ["queued", "delivering", "delivered", "delivery_unknown", "claimed", "accepted", "rejected", "running", "completed", "failed"];
type Env = { Variables: { principal: Principal } };

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new RangeError("body too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { void reader.cancel(); throw new RangeError("body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export function createCentralApp(deps: { auth: CentralAuth; commands: CentralMcpCommands; identities: SupervisorIdentityLookup & Partial<Pick<SupervisorIdentityRegistry, "lockActive">>; requests?: CentralRequests; allowedOrigins?: readonly string[]; listHosts?: () => { hostId: string; sessions: string[] | null }[] }) {
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
    if (origin && !deps.allowedOrigins?.includes(origin)) return c.json({ error: "unsafe origin" }, 403);
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
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(c.req.raw))); }
    catch (error) { return c.json({ error: error instanceof RangeError ? "body too large" : "invalid JSON" }, error instanceof RangeError ? 413 : 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return c.json({ error: "invalid command" }, 400);
    const body = input as Record<string, unknown>;
    if (typeof body.hostId !== "string" || !body.hostId.trim() || body.hostId.length > 256 || typeof body.target !== "string" || body.target.length > 256 || typeof body.text !== "string" || body.text.length > MAX_TEXT || typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) return c.json({ error: "invalid command" }, 400);
    const result = await deps.commands.submit({ hostId: body.hostId, target: body.target, text: body.text, idempotencyKey: body.idempotencyKey, actor: c.get("principal").name });
    return c.json(result, result.created ? 201 : 200);
  });
  app.get("/api/commands", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !statuses.includes(status as CommandStatus)) return c.json({ error: "invalid status" }, 400);
    const limitText = c.req.query("limit");
    if (limitText !== undefined && (!/^[1-9]\d*$/.test(limitText) || Number(limitText) > 1000)) return c.json({ error: "invalid limit" }, 400);
    const hostId = c.req.query("hostId");
    const target = c.req.query("target");
    if ((hostId !== undefined && (!hostId.trim() || hostId.length > 256)) || (target !== undefined && (!target.trim() || target.length > 256))) return c.json({ error: "invalid scope" }, 400);
    return c.json(await deps.commands.list(status as CommandStatus | undefined, { hostId, target }, { limit: limitText === undefined ? undefined : Number(limitText), cursor: c.req.query("cursor") }));
  });
  app.get("/api/commands/:id", async (c) => c.json({ command: await deps.commands.get(c.req.param("id")) }));
  app.all("/mcp", async (c) => {
    const principal = c.get("principal");
    if (principal.role !== "operator" && principal.role !== "supervisor") return c.json({ error: "forbidden" }, 403);
    let request = c.req.raw;
    if (request.method === "POST") {
      let body: Uint8Array<ArrayBuffer>;
      try { body = await boundedBody(request); } catch { return c.json({ error: "body too large" }, 413); }
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
