// Fleet Control host service. Loopback without auth for development; any other bind address
// requires bearer-token auth (see src/auth.ts and docs/installation.md).
import { Auth, COOKIE, isLoopback, type Principal } from "./auth.ts";
import login from "../web/login.html";
import { hostname as osHostname } from "node:os";
import { FleetError } from "./domain/fleet.ts";
import deck from "../web/index.html";
import { clampSize, openViewer, type Viewer } from "./terminal/viewer.ts";
import { CommandError } from "./domain/commands.ts";
import { commandUseCases } from "./application/commands.ts";
import { requestUseCases } from "./application/requests.ts";
import { sessionReader } from "./application/sessions.ts";
import { handleMcp, type ControlDeps } from "./mcp.ts";
import { RequestError } from "./domain/requests.ts";
import { RoleError } from "./domain/roles.ts";
import { AgentError } from "./domain/agents.ts";
import { agentUseCases, type AgentDeps } from "./application/agents.ts";
import type { LeaseUseCases } from "./application/leases.ts";
import { LeaseError, MAX_INPUT_BYTES } from "./domain/leases.ts";
import { AdminError } from "./domain/fleet-admin.ts";
import { adminUseCases, type AdminDeps } from "./application/fleet-admin.ts";
import { tokenUseCases, type TokenAdminDeps, type TokenUseCases } from "./application/token-admin.ts";
import { settingsUseCases, type SettingsDeps } from "./application/settings.ts";

const httpStatus: Record<FleetError["kind"], number> = {
  invalid_name: 400,
  session_missing: 404,
  config: 503,
  cli_failed: 502,
  malformed_output: 502,
};

function errorResponse(e: unknown): Response {
  if (e instanceof FleetError) {
    return Response.json({ error: { kind: e.kind, message: e.message } }, { status: httpStatus[e.kind] });
  }
  return Response.json({ error: { kind: "internal", message: "internal error" } }, { status: 500 });
}


export function createApp(deps: Parameters<typeof sessionReader>[0]) {
  const now = deps.now ?? (() => new Date());
  const reader = sessionReader(deps);

  return {
    async sessions(): Promise<Response> {
      try {
        const sessions = await reader.list();
        return Response.json({ sessions, source: "fleet status", readAt: now().toISOString() });
      } catch (e) {
        return errorResponse(e);
      }
    },

    async screen(name: string, lines: number): Promise<Response> {
      try {
        const text = await reader.screen(name, lines);
        return Response.json({ session: name, text, source: "fleet screen", readAt: now().toISOString() });
      } catch (e) {
        return errorResponse(e);
      }
    },
  };
}

type TerminalDeps = { fleetBin: string; confPath: string };

const commandStatus: Record<CommandError["kind"], number> = { not_found: 404, conflict: 409, invalid: 400 };
const requestStatus: Record<RequestError["kind"], number> = { not_found: 404, conflict: 409, invalid: 400, forbidden: 403 };
const agentStatus: Record<AgentError["kind"], number> = { invalid: 400, conflict: 409, not_found: 404, unavailable: 503 };
const leaseStatus: Record<LeaseError["kind"], number> = { invalid: 400, conflict: 409, not_found: 404, gone: 410 };
function commandError(e: unknown): Response {
  if (e instanceof AgentError) return Response.json({ error: { kind: e.kind, message: e.message } }, { status: agentStatus[e.kind] });
  if (e instanceof RoleError) return Response.json({ error: { kind: e.kind, message: e.message } }, { status: 403 });
  if (e instanceof RequestError) return Response.json({ error: { kind: e.kind, message: e.message } }, { status: requestStatus[e.kind] });
  if (e instanceof LeaseError) return Response.json({ error: { kind: e.kind, message: e.message } }, { status: leaseStatus[e.kind] });
  if (e instanceof CommandError) return Response.json({ error: { kind: e.kind, message: e.message } }, { status: commandStatus[e.kind] });
  return Response.json({ error: { kind: "internal", message: "internal error" } }, { status: 500 });
}
// Optional ?limit=&cursor= on the list routes. null means neither was given.
function pageQuery(req: Request): { limit?: number; cursor?: string } | null | Response {
  const params = new URL(req.url).searchParams;
  const bad = (message: string) => Response.json({ error: { kind: "invalid", message } }, { status: 400 });
  for (const key of params.keys()) if (key !== "limit" && key !== "cursor") return bad(`unknown query parameter ${key}`);
  if (params.getAll("limit").length > 1 || params.getAll("cursor").length > 1) return bad("duplicate query parameter");
  const limit = params.get("limit"), cursor = params.get("cursor");
  if (limit === null && cursor === null) return null;
  if (limit !== null && !/^[1-9][0-9]{0,3}$/.test(limit)) return bad("limit must be between 1 and 1000");
  if (cursor !== null && (cursor.length === 0 || cursor.length > 4096)) return bad("invalid cursor or cursor filter mismatch");
  return { ...(limit !== null ? { limit: Number(limit) } : {}), ...(cursor !== null ? { cursor } : {}) };
}
const adminStatus: Record<AdminError["kind"], number> = { invalid: 400, conflict: 409, not_found: 404, unavailable: 503, failed: 422 };
// Admin calls touch host files and programs; their plain failures (a missing log, a failed read) go back
// to the operator as 503 with the reason, since only an operator can reach them.
function adminError(e: unknown): Response {
  if (e instanceof AdminError) return Response.json({ error: { kind: e.kind, message: e.message } }, { status: adminStatus[e.kind] });
  if (e instanceof RoleError) return Response.json({ error: { kind: e.kind, message: e.message } }, { status: 403 });
  const message = e instanceof Error ? e.message : String(e);
  console.error(`fleet admin: ${message}`);
  return Response.json({ error: { kind: "unavailable", message } }, { status: 503 });
}
const forbidden = () => Response.json({ error: { kind: "forbidden", message: "cross-origin request" } }, { status: 403 });
const noControl = () => Response.json({ error: { kind: "unavailable", message: "command queue not configured" } }, { status: 503 });

// Writes from a browser must come from a page this service served. MCP clients send no Origin.
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin === null || origin === new URL(req.url).origin;
}
// `id` names the socket for an input lease; the page learns it from the first text frame.
type SocketData = { id: string; session: string; cols: number; rows: number; viewer?: Viewer; closed?: boolean; principal?: Principal; busy?: boolean; typing?: Promise<void> };

// Browsers send Origin on WebSocket upgrades; only pages served by this service may open a terminal.
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && origin === new URL(req.url).origin;
}

type Routes = "/api/hosts" | "/" | "/login" | "/api/login" | "/logout" | "/api/whoami" | "/api/sessions" | "/api/sessions/:name/screen" | "/api/sessions/:name/terminal" | "/api/terminal" | "/api/commands" | "/api/commands/:id" | "/api/requests" | "/api/requests/:id/resolve" | "/api/agents" | "/api/agents/:name/stop" | "/api/sessions/:name/lease" | "/api/leases" | "/api/fleet/conf" | "/api/fleet/logs" | "/api/sessions/:name/restart" | "/api/tokens" | "/api/tokens/:name/rotate" | "/api/tokens/:name/revoke" | "/api/token/replace" | "/api/token/revoke" | "/api/settings" | "/mcp";

export type Peer = { name: string; url: string };

export type ServeOptions = {
  hostName?: string; // label for this host in the nav; default os.hostname()
  peers?: Peer[]; // other hosts' own services, shown as links; this service never proxies them
  hostname?: string; // default 127.0.0.1
  auth?: Auth; // required unless hostname is loopback
  allowedHosts?: string[]; // extra Host header values for MCP, e.g. "192.168.50.4:4871"
  tls?: { cert: string; key: string }; // PEM text
  maxViewers?: number; // open terminal sockets at once, each one a PTY process; default MAX_VIEWERS
  viewerSlots?: ViewerSlots; // pass the same slots to every listener of one process so the cap is per process
};

export const MAX_VIEWERS = 16;
// How long a restart request may stay open while the session starts again.
export const RESTART_IDLE_SECONDS = 200;

// The open terminal sockets of one process. Two listeners share one, so together they stay under the cap.
export class ViewerSlots {
  open = 0;
  // Ids of the terminal sockets open now on any listener of this process. A lease is granted on one listener
  // and swept by every listener's sweeper, so "is this socket still open" must see them all.
  readonly socketIds = new Set<string>();
  constructor(readonly max = MAX_VIEWERS) {
    if (!Number.isSafeInteger(max) || max < 1) throw new Error("maxViewers must be a positive integer");
  }
}
export const BUSY_REASON = "too many open terminal viewers";

export const MAX_REQUEST_BODY = 256 * 1024;

function hostLabel(): string {
  return osHostname().replace(/\.local$/, "");
}

const unauthorized = () =>
  Response.json({ error: { kind: "unauthorized", message: "missing or invalid token" } }, { status: 401, headers: { "www-authenticate": "Bearer" } });

export function serve(deps: Parameters<typeof createApp>[0] & { terminal?: TerminalDeps; control?: ControlDeps; agents?: AgentDeps; input?: LeaseUseCases; admin?: AdminDeps; tokens?: TokenAdminDeps; settings?: SettingsDeps }, port = 4871, opts: ServeOptions = {}) {
  const hostname = opts.hostname ?? "127.0.0.1";
  if (!isLoopback(hostname) && !opts.auth) throw new Error(`refusing to bind ${hostname} without auth; set FLEET_CONTROL_TOKENS`);
  const auth = opts.auth;
  // Without tokens anyone who can reach the port could start an unattended agent, even on loopback.
  if (deps.agents && !auth) throw new Error("managed agents need tokens; set FLEET_CONTROL_TOKENS");
  const app = createApp(deps);
  const terminal = deps.terminal;
  // A command carrying one of this service's tokens is refused on REST and MCP alike.
  const control = deps.control && auth ? { ...deps.control, carriesSecret: (text: string) => auth.appearsIn(text) } : deps.control;
  // With auth the caller's name replaces any actor the body declares; the use cases apply that rule.
  const queueFor = (who: Principal | null) => (control ? commandUseCases(control, who ?? undefined) : null);
  const agentDeps = deps.agents && auth ? { ...deps.agents, carriesSecret: (text: string) => auth.appearsIn(text) } : undefined;
  const agentsFor = (who: Principal | null) => (agentDeps ? agentUseCases(agentDeps, who ?? undefined) : null);
  const noAgents = () => Response.json({ error: { kind: "unavailable", message: "managed agents not configured on this host" } }, { status: 503 });
  // Terminal input needs tokens, like starting agents: on loopback without auth anyone could type.
  if (deps.input && !auth) throw new Error("terminal input needs tokens; set FLEET_CONTROL_TOKENS");
  const input = deps.input;
  const noInput = () => Response.json({ error: { kind: "unavailable", message: "terminal input not configured on this host" } }, { status: 503 });
  // Editing fleet.conf and restarting sessions need tokens, like starting agents.
  if (deps.admin && !auth) throw new Error("fleet administration needs tokens; set FLEET_CONTROL_TOKENS");
  const adminFor = (who: Principal | null) => (deps.admin ? adminUseCases(deps.admin, who ?? undefined) : null);
  const noAdmin = () => Response.json({ error: { kind: "unavailable", message: "fleet administration not configured on this host" } }, { status: 503 });
  if (deps.tokens && !auth) throw new Error("token administration needs tokens; set FLEET_CONTROL_TOKENS");
  if (deps.settings && !auth) throw new Error("service settings need tokens; set FLEET_CONTROL_TOKENS");
  const settingsFor = (who: Principal | null) => (deps.settings ? settingsUseCases(deps.settings, who ?? undefined) : null);
  const noSettings = () => Response.json({ error: { kind: "unavailable", message: "service settings not configured on this host" } }, { status: 503 });
  const tokensFor = (who: Principal | null) => (deps.tokens ? tokenUseCases(deps.tokens, who ?? undefined) : null);
  const noTokens = () => Response.json({ error: { kind: "unavailable", message: "token administration not configured on this host" } }, { status: 503 });
  // Writes that take a JSON body: Origin checked, the body an object, errors mapped like fleet administration.
  const tokenWrite = (run: (t: TokenUseCases, body: Record<string, unknown>, req: any) => Promise<unknown>) => guard(async (req, _s, who) => {
    const t = tokensFor(who);
    if (!t) return noTokens();
    if (!originAllowed(req)) return forbidden();
    if ((req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return Response.json({ error: { kind: "invalid", message: "content-type must be application/json" } }, { status: 415 });
    try {
      const body = await jsonBody(req);
      if (!body) return Response.json({ error: { kind: "invalid", message: "body must be an object" } }, { status: 400 });
      // A new token is shown once; no cache may keep it.
      return Response.json(await run(t, body as Record<string, unknown>, req), { headers: { "cache-control": "no-store" } });
    } catch (e) { return adminError(e); }
  });
  const jsonBody = async (req: Request) => {
    const body: unknown = await req.json().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  };
  const requestsFor = (who: Principal | null) => (control?.requests ? requestUseCases(control.requests, who ?? undefined) : null);

  // With auth, every API, MCP and terminal call needs a principal; the principal is the actor.
  type Handler = (req: any, server: any) => Response | Promise<Response> | undefined | Promise<Response | undefined>;
  const guard = (h: (req: any, server: any, who: Principal | null) => ReturnType<Handler>): Handler => (req, srv) => {
    if (!auth) return h(req, srv, null);
    const who = auth.principal(req);
    return who ? h(req, srv, who) : unauthorized();
  };

  // Every socket starts a PTY process, so the number open at once is capped. A slot is taken at the
  // upgrade and given back when the socket closes.
  const slots = opts.viewerSlots ?? new ViewerSlots(opts.maxViewers ?? MAX_VIEWERS);
  // Open terminal sockets, so a token reload can close the ones whose token was revoked or rotated.
  const sockets = new Set<{ data: SocketData; close(code?: number, reason?: string): void; sendText(text: string): number }>();
  // This listener's sockets only: a lease granted here belongs to one of them.
  const socketById = (id: string) => [...sockets].find((ws) => ws.data.id === id);
  const tell = (ws: { sendText(text: string): number } | undefined, msg: object) => { try { ws?.sendText(JSON.stringify(msg)); } catch { /* closed */ } };
  // A lease that ends for any reason tells its socket, which goes back to read-only.
  const unlisten = input?.onEnd((lease, reason) => tell(socketById(lease.socketId), { type: "lease", state: "ended", session: lease.session, reason }));
  // Expiry and a restarted session end a lease even while nobody types.
  const sweeper = input ? setInterval(() => { input.sweep((id) => slots.socketIds.has(id)).catch((e) => console.error(`lease sweep failed: ${e instanceof Error ? e.message : e}`)); }, 1000) : undefined;
  const unsubscribe = auth?.onReplace(() => {
    for (const ws of sockets) if (ws.data.principal && !auth.current(ws.data.principal)) ws.close(1008, "token revoked");
  });
  const openTerminal = (req: Request, server: any, who: Principal | null, session: string) => {
    if (!terminal) return Response.json({ error: { kind: "unavailable", message: "terminal viewer not configured" } }, { status: 503 });
    if (!sameOrigin(req)) return Response.json({ error: { kind: "forbidden", message: "cross-origin terminal request" } }, { status: 403 });
    const url = new URL(req.url);
    const size = clampSize(Number(url.searchParams.get("cols") ?? 80), Number(url.searchParams.get("rows") ?? 24));
    if (!size || !/^[A-Za-z0-9._-]+$/.test(session)) {
      return Response.json({ error: { kind: "invalid_name", message: "bad session name or size" } }, { status: 400 });
    }
    // A browser cannot read the status of a refused upgrade, so over the cap the socket opens and closes
    // at once with 1013 and a reason the page can show. It never takes a slot.
    if (slots.open >= slots.max) {
      if (server.upgrade(req, { data: { id: crypto.randomUUID(), session, ...size, busy: true } })) return undefined;
      return Response.json({ error: { kind: "busy", message: "too many open terminal viewers" } }, { status: 503 });
    }
    if (server.upgrade(req, { data: { id: crypto.randomUUID(), session, ...size, principal: who ?? undefined } })) { slots.open++; return undefined; }
    return Response.json({ error: { kind: "upgrade_failed", message: "expected a WebSocket upgrade" } }, { status: 400 });
  };

  const server: ReturnType<typeof Bun.serve<SocketData, Routes>> = Bun.serve<SocketData, Routes>({
    hostname,
    port,
    // Bun's default is 128 MiB. The largest valid body (an MCP request_create at its field limits) is
    // well under this, and Bun answers 413 before a handler reads anything.
    maxRequestBodySize: MAX_REQUEST_BODY,
    // Bun serves HTML imports in development mode by default: source maps, original source and hot
    // reload, all readable without a token. Always serve the production build.
    development: false,
    ...(opts.tls ? { tls: opts.tls } : {}),
    routes: {
      "/": deck,
      "/login": login,
      "/api/login": {
        // Exchanges a token for an HttpOnly cookie, so the page's JavaScript never holds it.
        POST: async (req) => {
          if (!auth) return Response.redirect("/", 303);
          if (!sameOrigin(req)) return forbidden();
          const form = await req.formData().catch(() => null);
          const value = form?.get("token");
          const token = typeof value === "string" ? value.trim() : "";
          const who = auth.check(token);
          if (!who) return Response.redirect("/login?failed=1", 303);
          const secure = opts.tls ? "; Secure" : "";
          return new Response(null, {
            status: 303,
            headers: {
              location: "/",
              "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
            },
          });
        },
      },
      "/logout": {
        POST: (req) => {
          if (!sameOrigin(req)) return forbidden();
          return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` } });
        },
      },
      // Each host runs its own service and owns its own state. Peers are listed so the nav can show
      // and link them; their sessions are not read from here.
      "/api/hosts": {
        GET: guard(() => Response.json({
          self: { name: opts.hostName ?? hostLabel(), url: null },
          peers: opts.peers ?? [],
        })),
      },
      "/api/whoami": { GET: guard((_req, _s, who) => Response.json({ principal: who?.name ?? null, role: who?.role ?? null, auth: Boolean(auth) })) },
      "/api/sessions": { GET: guard(() => app.sessions()) },
      // Managed Claude Code agents: list for anyone signed in, start and stop for an operator.
      "/api/agents": {
        GET: guard(async (_req, _s, who) => {
          const agents = agentsFor(who);
          if (!agents) return noAgents();
          // models: the Claude Code list, as before DSH agents; kinds: models per kind offered here.
          try { return Response.json({ agents: await agents.list(), models: agents.models.claude ?? [], kinds: agents.models, orchestrators: agents.orchestrators, folders: await agents.folders() }); } catch (e) { return commandError(e); }
        }),
        POST: guard(async (req, _s, who) => {
          const agents = agentsFor(who);
          if (!agents) return noAgents();
          if (!originAllowed(req)) return forbidden();
          try {
            const body: unknown = await req.json().catch(() => null);
            if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: { kind: "invalid", message: "body must be an object" } }, { status: 400 });
            const { agent } = await agents.start(body as Record<string, unknown>);
            return Response.json({ agent }, { status: 202 });
          } catch (e) { return commandError(e); }
        }),
      },
      // Fleet administration: operator only. GET answers too, since fleet.conf and logs can hold host details.
      "/api/fleet/conf": {
        GET: guard(async (_req, _s, who) => {
          const admin = adminFor(who);
          if (!admin) return noAdmin();
          try { return Response.json(await admin.conf()); } catch (e) { return adminError(e); }
        }),
        PUT: guard(async (req, _s, who) => {
          const admin = adminFor(who);
          if (!admin) return noAdmin();
          if (!originAllowed(req)) return forbidden();
          try {
            const body = await jsonBody(req);
            if (!body) return Response.json({ error: { kind: "invalid", message: "body must be an object" } }, { status: 400 });
            return Response.json(await admin.saveConf(body));
          } catch (e) { return adminError(e); }
        }),
      },
      "/api/fleet/logs": {
        GET: guard(async (req, _s, who) => {
          const admin = adminFor(who);
          if (!admin) return noAdmin();
          const q = new URL(req.url).searchParams;
          try { return Response.json(await admin.log(q.get("source"), q.get("lines"))); } catch (e) { return adminError(e); }
        }),
      },
      "/api/sessions/:name/restart": {
        POST: guard(async (req, srv, who) => {
          const admin = adminFor(who);
          if (!admin) return noAdmin();
          if (!originAllowed(req)) return forbidden();
          // fleet start can wait 90 s for an agent; Bun would drop the idle connection after 10 s.
          srv.timeout(req, RESTART_IDLE_SECONDS);
          try {
            const body = await jsonBody(req);
            if (!body) return Response.json({ error: { kind: "invalid", message: "body must be an object" } }, { status: 400 });
            return Response.json(await admin.restart(req.params.name, body));
          } catch (e) { return adminError(e); }
        }),
      },
      // The tokens file: operator only. Names and roles, never hashes.
      "/api/settings": {
        GET: guard(async (_req, _s, who) => {
          const st = settingsFor(who);
          if (!st) return noSettings();
          try { return Response.json(await st.get()); } catch (e) { return adminError(e); }
        }),
        PUT: guard(async (req, _s, who) => {
          const st = settingsFor(who);
          if (!st) return noSettings();
          if (!originAllowed(req)) return forbidden();
          if ((req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return Response.json({ error: { kind: "invalid", message: "content-type must be application/json" } }, { status: 415 });
          try {
            const body = await jsonBody(req);
            if (!body) return Response.json({ error: { kind: "invalid", message: "body must be an object" } }, { status: 400 });
            return Response.json(await st.save(body));
          } catch (e) { return adminError(e); }
        }),
      },
      "/api/tokens": {
        GET: guard(async (_req, _s, who) => {
          const t = tokensFor(who);
          if (!t) return noTokens();
          try { return Response.json(await t.list()); } catch (e) { return adminError(e); }
        }),
      },
      "/api/tokens/:name/rotate": { POST: tokenWrite((t, body, req) => t.rotate(req.params.name, body)) },
      "/api/tokens/:name/revoke": { POST: tokenWrite((t, body, req) => t.revoke(req.params.name, body)) },
      // The caller's own token: a gateway replaces it with a hash it made, or gives it up.
      "/api/token/replace": { POST: tokenWrite((t, body) => t.replaceOwn(body)) },
      "/api/token/revoke": { POST: tokenWrite((t, body) => t.revokeOwn(body)) },
      "/api/agents/:name/stop": {
        POST: guard(async (req, _s, who) => {
          const agents = agentsFor(who);
          if (!agents) return noAgents();
          if (!originAllowed(req)) return forbidden();
          try { return Response.json({ agent: await agents.stop(req.params.name) }); } catch (e) { return commandError(e); }
        }),
      },
      "/api/sessions/:name/screen": {
        GET: guard((req) => {
          const raw = new URL(req.url).searchParams.get("lines");
          const lines = raw === null ? 40 : Number(raw);
          return app.screen(req.params.name, lines);
        }),
      },
      // The web UI reads and queues commands here; MCP clients use /mcp. Both share one queue.
      "/api/commands": {
        // Without parameters the whole list; latest=N the newest N (what the page polls); limit or cursor one keyset page.
        GET: guard((req, _s, who) => {
          const queue = queueFor(who);
          if (!queue) return noControl();
          const params = new URL(req.url).searchParams;
          if (params.has("latest")) {
            const latest = params.getAll("latest");
            if (latest.length > 1 || [...params.keys()].some((k) => k !== "latest")) return Response.json({ error: { kind: "invalid", message: "latest takes no other query parameter" } }, { status: 400 });
            if (!/^[1-9][0-9]{0,3}$/.test(latest[0]!) || Number(latest[0]) > 1000) return Response.json({ error: { kind: "invalid", message: "latest must be between 1 and 1000" } }, { status: 400 });
            try { return Response.json({ commands: queue.latest(Number(latest[0])) }); } catch (e) { return commandError(e); }
          }
          const page = pageQuery(req);
          if (page instanceof Response) return page;
          try { return Response.json(page ? queue.page(page) : { commands: queue.list() }); } catch (e) { return commandError(e); }
        }),
        POST: guard(async (req, _s, who) => {
          const queue = queueFor(who);
          if (!queue) return noControl();
          if (!originAllowed(req)) return forbidden();
          try {
            const body: unknown = await req.json();
            if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: { kind: "invalid", message: "body must be an object" } }, { status: 400 });
            const fields = body as Record<string, unknown>;
            const str = (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : "");
            const result = await queue.submit({
              idempotencyKey: str("idempotencyKey"),
              target: str("target"),
              actor: str("actor") || "web-ui",
              text: str("text"),
            });
            return Response.json(result, { status: result.created ? 201 : 200 });
          } catch (e) {
            if (e instanceof SyntaxError) return Response.json({ error: { kind: "invalid", message: "body is not JSON" } }, { status: 400 });
            return commandError(e);
          }
        }),
      },
      "/api/commands/:id": {
        GET: guard((req, _s, who) => {
          const queue = queueFor(who);
          if (!queue) return noControl();
          try {
            return Response.json(queue.read(req.params.id));
          } catch (e) {
            return commandError(e);
          }
        }),
      },
      "/api/requests": {
        GET: guard((req, _s, who) => {
          const requests = requestsFor(who);
          if (!requests) return noControl();
          const params = new URL(req.url).searchParams;
          if (params.has("view")) {
            if ([...params.keys()].length !== 1 || params.get("view") !== "current") return Response.json({ error: { kind: "invalid", message: "view must be current and takes no other query parameter" } }, { status: 400 });
            try { return Response.json(requests.current()); } catch (e) { return commandError(e); }
          }
          const page = pageQuery(req);
          if (page instanceof Response) return page;
          try { return Response.json(page ? requests.page(page) : requests.overview()); } catch (e) { return commandError(e); }
        }),
      },
      // A human answer from the page. Bound to the request id and the revision the page showed.
      "/api/requests/:id/resolve": {
        POST: guard(async (req, _s, who) => {
          const requests = requestsFor(who);
          if (!requests) return noControl();
          if (!originAllowed(req) || req.headers.get("origin") === null) return forbidden();
          try {
            const body: unknown = await req.json();
            if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: { kind: "invalid", message: "body must be an object" } }, { status: 400 });
            const b = body as Record<string, unknown>;
            const request = requests.resolve({
              requestId: req.params.id,
              response: typeof b.response === "string" ? b.response : "",
              actor: "web-ui",
              expectedRevision: typeof b.expectedRevision === "number" ? b.expectedRevision : -1,
              note: typeof b.note === "string" ? b.note : undefined,
            });
            return Response.json({ request });
          } catch (e) {
            if (e instanceof SyntaxError) return Response.json({ error: { kind: "invalid", message: "body is not JSON" } }, { status: 400 });
            return commandError(e);
          }
        }),
      },
      // Input lease on one session, for one open terminal socket of the caller. Same Origin only.
      "/api/sessions/:name/lease": {
        POST: guard(async (req, _s, who) => {
          if (!input) return noInput();
          if (!originAllowed(req) || req.headers.get("origin") === null) return forbidden();
          try {
            const body: unknown = await req.json();
            if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: { kind: "invalid", message: "body must be an object" } }, { status: 400 });
            const b = body as Record<string, unknown>;
            const id = typeof b.socket === "string" ? b.socket : "";
            const ws = id ? socketById(id) : undefined;
            const socket = ws && !ws.data.closed ? { owner: ws.data.principal?.name ?? "local", session: ws.data.session, isOpen: () => !ws.data.closed } : undefined;
            const lease = await input.grant(who ?? undefined, { session: req.params.name, socketId: id, socket, minutes: b.minutes, reason: b.reason });
            tell(ws, { type: "lease", state: "granted", session: lease.session, expiresAt: lease.expiresAt });
            return Response.json({ lease }, { status: 201 });
          } catch (e) {
            if (e instanceof SyntaxError) return Response.json({ error: { kind: "invalid", message: "body is not JSON" } }, { status: 400 });
            return commandError(e);
          }
        }),
        DELETE: guard(async (req, _s, who) => {
          if (!input) return noInput();
          if (!originAllowed(req) || req.headers.get("origin") === null) return forbidden();
          try {
            const reason = new URL(req.url).searchParams.get("reason") ?? undefined;
            return Response.json(await input.release(who ?? undefined, req.params.name, reason));
          } catch (e) { return commandError(e); }
        }),
      },
      // Who holds which session is for callers who may type themselves.
      "/api/leases": { GET: guard((_req, _s, who) => {
        if (!input) return noInput();
        try { return Response.json({ leases: input.list(who ?? undefined) }); } catch (e) { return commandError(e); }
      }) },
      // Streamable HTTP MCP endpoint. DNS rebinding protection admits only the configured Host headers.
      "/mcp": guard(async (req, _s, who) => {
        if (!control) return noControl();
        if (!originAllowed(req)) return forbidden();
        const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`, ...(isLoopback(hostname) ? [] : [`${hostname}:${server.port}`]), ...(opts.allowedHosts ?? [])];
        return handleMcp(req, control, hosts, who ?? undefined);
      }),
      // Terminal stream. Output is read-only; a client message is accepted only as input from the socket
      // that holds the session's input lease. There is no resize: the viewer may be the agent's only tmux client.
      "/api/sessions/:name/terminal": { GET: guard((req, server, who) => openTerminal(req, server, who, req.params.name)) },
      // Same stream with the session in the query, so a proxy that routes WebSocket upgrades by exact
      // path (the DeepSeek Harness panel) can carry every session over one path.
      "/api/terminal": { GET: guard((req, server, who) => openTerminal(req, server, who, new URL(req.url).searchParams.get("session") ?? "")) },
    },
    websocket: {
      // One input message is at most MAX_INPUT_BYTES; Bun closes a socket that sends more.
      maxPayloadLength: MAX_INPUT_BYTES,
      async open(ws) {
        if (ws.data.busy) return ws.close(1013, BUSY_REASON);
        sockets.add(ws);
        slots.socketIds.add(ws.data.id);
        // Text frames are control messages; terminal output is always binary.
        if (input) tell(ws, { type: "socket", id: ws.data.id, session: ws.data.session });
        try {
          const viewer = await openViewer({
            ...terminal!,
            session: ws.data.session,
            cols: ws.data.cols,
            rows: ws.data.rows,
            onData: (d) => { if (!ws.data.closed) ws.sendBinary(d); },
            onExit: (code) => { if (!ws.data.closed) ws.close(code === 0 ? 1000 : 1011, `viewer exited ${code}`); },
          });
          if (ws.data.closed) viewer.close();
          else ws.data.viewer = viewer;
        } catch (e) {
          ws.close(1011, e instanceof Error ? e.message.slice(0, 120) : "viewer failed");
        }
      },
      message(ws, message) {
        if (!input) return ws.close(1008, "read-only terminal: client messages are not accepted");
        // Keys come as binary frames only; text frames from the page are control messages, and the host takes none.
        if (typeof message === "string") return ws.close(1008, "read-only terminal: keys must be binary messages");
        const bytes = new Uint8Array(message);
        // In order, one at a time: a key typed after another must arrive after it.
        const prev = ws.data.typing ?? Promise.resolve();
        ws.data.typing = prev.then(() => input.input(ws.data.session, ws.data.id, bytes)).catch((e) => {
          if (ws.data.closed) return;
          if (e instanceof LeaseError && e.kind === "gone") return ws.close(1008, "read-only terminal: no input lease for this socket");
          tell(ws, { type: "input_error", message: e instanceof Error ? e.message.slice(0, 200) : "input failed" });
        });
      },
      close(ws) {
        if (ws.data.busy) return;
        if (!ws.data.closed) slots.open--;
        sockets.delete(ws);
        slots.socketIds.delete(ws.data.id);
        ws.data.closed = true;
        input?.socketClosed(ws.data.id);
        ws.data.viewer?.close();
      },
    },
    fetch: () => Response.json({ error: { kind: "not_found", message: "not found" } }, { status: 404 }),
  });
  // A stopped server must not stay subscribed to a shared Auth, or every later reload still reaches it.
  // Some tests replace Bun.serve with a stub that has no stop.
  if ((unsubscribe || unlisten || sweeper) && typeof server?.stop === "function") {
    const stop = server.stop.bind(server);
    server.stop = (force?: boolean) => { unsubscribe?.(); unlisten?.(); clearInterval(sweeper); return stop(force); };
  }
  return server;
}
