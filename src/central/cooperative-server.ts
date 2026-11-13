import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CommandError, MAX_TEXT } from "../commands.ts";
import { supervisorIdentity, type CentralAuth, type SupervisorIdentityLookup } from "./auth.ts";
import { buildCentralMcpServer, type CentralMcpCommands } from "./mcp.ts";
import type { CentralCommands } from "./commands.ts";
import { buildCooperativeMcpServer } from "./cooperative-mcp.ts";
import type { CooperativeClaims } from "./cooperative-claims.ts";
import type { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import type { CooperativeInspection } from "./cooperative-inspection.ts";
import { createCooperativeInspectionRoute } from "./cooperative-inspection-route.ts";
import { createCooperativeAssertionsRoute } from "./cooperative-assertions-route.ts";
import type { CooperativeReconciliation } from "./cooperative-reconciliation.ts";
import type { CooperativeSettlement } from "./cooperative-settlement.ts";
import { createCooperativeSettlementRoute } from "./cooperative-settlement-route.ts";

const MAX_BODY = 32 * 1024;
const MAX_COMMAND_LIST_BODY = 2 * 1024 * 1024;
// Allow 65536 UTF-16 code units escaped as six JSON bytes each, plus envelope.
const MAX_MCP_BODY = 512 * 1024;

async function readBody(request: Request, maxBody = MAX_BODY): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBody)) throw new RangeError();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBody) { void reader.cancel().catch(() => {}); throw new RangeError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export type CooperativeCommands = Pick<CentralCommands, "submitBounded" | "getBounded" | "listBounded">;

export function createCooperativeCentralApp(deps: {
  auth: CentralAuth;
  identities: SupervisorIdentityLookup;
  commands: CooperativeCommands;
  claims: CooperativeClaims;
  lifecycle: CooperativeLifecycle;
  inspection: Pick<CooperativeInspection, "inspectBounded">;
  reconciliation?: Pick<CooperativeReconciliation, "listBounded">;
  settlement?: Pick<CooperativeSettlement, "get" | "settle">;
  requests?: never;
  allowedOrigins?: readonly string[];
}) {
  if (deps.requests !== undefined) throw new Error("cooperative request store is unsupported");
  const commands: CentralMcpCommands = {
    submit: (...args) => deps.commands.submitBounded(...args),
    get: (...args) => deps.commands.getBounded(...args),
    list: (...args) => deps.commands.listBounded(...args),
    transition: async () => { throw new Error("legacy mutation unavailable"); },
  };
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof CommandError) return c.json({ error: error.message }, error.kind === "not_found" ? 404 : error.kind === "conflict" ? 409 : 400);
    return c.json({ error: "request failed" }, 500);
  });
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
    await next();
  });
  app.route("/", createCooperativeInspectionRoute({ auth: deps.auth, inspection: deps.inspection }));
  if (deps.reconciliation) app.route("/", createCooperativeAssertionsRoute({ auth: deps.auth, reconciliation: deps.reconciliation }));
  if (deps.settlement) app.route("/", createCooperativeSettlementRoute({ auth: deps.auth, settlement: deps.settlement }));
  app.get("/api/commands", async (c) => {
    const principal = deps.auth.authenticate(c.req.raw);
    if (!principal || principal.role !== "operator") return c.json({ error: "forbidden" }, 403);
    const query = new URL(c.req.url).searchParams;
    const allowed = new Set(["hostId", "target", "limit", "cursor"]);
    for (const key of query.keys()) {
      if (!allowed.has(key) || query.getAll(key).length !== 1) return c.json({ error: "invalid query" }, 400);
    }
    const hostId = query.get("hostId");
    const target = query.get("target");
    if ([hostId, target].some((value) => value === null || !value.trim() || value.length > 256 || !value.isWellFormed() || value.includes("\0"))) return c.json({ error: "invalid scope" }, 400);
    const limitText = query.get("limit");
    if (limitText !== null && !/^[1-4]$/.test(limitText)) return c.json({ error: "invalid limit" }, 400);
    const cursor = query.get("cursor") ?? undefined;
    if (cursor !== undefined && (cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor))) return c.json({ error: "invalid cursor" }, 400);
    const page = await deps.commands.listBounded(undefined, { hostId: hostId!, target: target! }, { limit: limitText === null ? 4 : Number(limitText), cursor });
    const body = JSON.stringify(page);
    if (Buffer.byteLength(body, "utf8") > MAX_COMMAND_LIST_BODY) throw new Error("command list too large");
    return c.body(body, 200, { "Content-Type": "application/json" });
  });
  app.get("/api/commands/:id", async (c) => {
    const principal = deps.auth.authenticate(c.req.raw);
    if (!principal || principal.role !== "operator") return c.json({ error: "forbidden" }, 403);
    return c.json({ command: await deps.commands.getBounded(c.req.param("id")) });
  });
  app.post("/api/commands", async (c) => {
    const principal = deps.auth.authenticate(c.req.raw);
    if (!principal || principal.role !== "operator") return c.json({ error: "forbidden" }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "expected JSON" }, 415);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c.req.raw))); }
    catch (error) { return c.json({ error: error instanceof RangeError ? "body too large" : "invalid JSON" }, error instanceof RangeError ? 413 : 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return c.json({ error: "invalid command" }, 400);
    const body = input as Record<string, unknown>;
    if (typeof body.hostId !== "string" || !body.hostId.trim() || body.hostId.length > 256 || typeof body.target !== "string" || body.target.length > 256 || typeof body.text !== "string" || body.text.length > MAX_TEXT || typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) return c.json({ error: "invalid command" }, 400);
    const result = await deps.commands.submitBounded({ hostId: body.hostId, target: body.target, text: body.text, idempotencyKey: body.idempotencyKey, actor: principal.name });
    return c.json(result, result.created ? 201 : 200);
  });
  app.all("/mcp", async (c) => {
    const principal = deps.auth.authenticate(c.req.raw);
    if (!principal || principal.role === "host") return c.json({ error: "forbidden" }, 403);
    let credential: { incarnationId: string; token: string } | undefined;
    if (principal.role === "supervisor") {
      const incarnationId = c.req.header("x-fleet-incarnation-id") ?? "";
      const token = c.req.header("x-fleet-incarnation-token") ?? "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(incarnationId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return c.json({ error: "unauthorized" }, 401);
      credential = { incarnationId, token };
    }
    let request = c.req.raw;
    if (request.method === "POST") {
      let body: Uint8Array<ArrayBuffer>;
      try { body = await readBody(request, MAX_MCP_BODY); } catch { return c.json({ error: "body too large" }, 413); }
      let decoded: string;
      try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(body); }
      catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
      let parsed: unknown;
      try { parsed = JSON.parse(decoded); } catch { /* Let the transport handle malformed JSON. */ }
      if (Array.isArray(parsed)) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "JSON-RPC batches are not supported" } }, 400);
      if (parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, "id")) {
        const id = (parsed as Record<string, unknown>).id;
        if (id !== null && !(typeof id === "string" && id.length <= 256) && !(typeof id === "number" && Number.isSafeInteger(id))) {
          return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, 400);
        }
      }
      request = new Request(request.url, { method: request.method, headers: request.headers, body });
    }
    const server = principal.role === "operator"
      ? buildCentralMcpServer({ commands }, principal, { commandListLimit: 4 })
      : buildCooperativeMcpServer({ claims: deps.claims, lifecycle: deps.lifecycle }, principal, credential!);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try { await server.connect(transport); return await transport.handleRequest(request); }
    finally { await server.close(); }
  });
  return app;
}
