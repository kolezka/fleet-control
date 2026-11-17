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
function commandError(e: unknown): Response {
  if (e instanceof RequestError) return Response.json({ error: { kind: e.kind, message: e.message } }, { status: requestStatus[e.kind] });
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
const forbidden = () => Response.json({ error: { kind: "forbidden", message: "cross-origin request" } }, { status: 403 });
const noControl = () => Response.json({ error: { kind: "unavailable", message: "command queue not configured" } }, { status: 503 });

// Writes from a browser must come from a page this service served. MCP clients send no Origin.
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin === null || origin === new URL(req.url).origin;
}
type SocketData = { session: string; cols: number; rows: number; viewer?: Viewer; closed?: boolean; principal?: Principal; busy?: boolean };

// Browsers send Origin on WebSocket upgrades; only pages served by this service may open a terminal.
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && origin === new URL(req.url).origin;
}

type Routes = "/api/hosts" | "/" | "/login" | "/api/login" | "/logout" | "/api/whoami" | "/api/sessions" | "/api/sessions/:name/screen" | "/api/sessions/:name/terminal" | "/api/terminal" | "/api/commands" | "/api/commands/:id" | "/api/requests" | "/api/requests/:id/resolve" | "/mcp";

export type Peer = { name: string; url: string };

export type ServeOptions = {
  hostName?: string; // label for this host in the nav; default os.hostname()
  peers?: Peer[]; // other hosts' own services, shown as links; this service never proxies them
  hostname?: string; // default 127.0.0.1
  auth?: Auth; // required unless hostname is loopback
  allowedHosts?: string[]; // extra Host header values for MCP, e.g. "192.168.50.4:4871"
  tls?: { cert: string; key: string }; // PEM text
  maxViewers?: number; // open terminal sockets at once, each one a PTY process; default MAX_VIEWERS
};

export const MAX_VIEWERS = 16;
export const BUSY_REASON = "too many open terminal viewers";

export const MAX_REQUEST_BODY = 256 * 1024;

function hostLabel(): string {
  return osHostname().replace(/\.local$/, "");
}

const unauthorized = () =>
  Response.json({ error: { kind: "unauthorized", message: "missing or invalid token" } }, { status: 401, headers: { "www-authenticate": "Bearer" } });

export function serve(deps: Parameters<typeof createApp>[0] & { terminal?: TerminalDeps; control?: ControlDeps }, port = 4871, opts: ServeOptions = {}) {
  const hostname = opts.hostname ?? "127.0.0.1";
  if (!isLoopback(hostname) && !opts.auth) throw new Error(`refusing to bind ${hostname} without auth; set FLEET_CONTROL_TOKENS`);
  const auth = opts.auth;
  const app = createApp(deps);
  const terminal = deps.terminal;
  const control = deps.control;
  // With auth the caller's name replaces any actor the body declares; the use cases apply that rule.
  const queueFor = (who: Principal | null) => (control ? commandUseCases(control, who?.name) : null);
  const requestsFor = (who: Principal | null) => (control?.requests ? requestUseCases(control.requests, who?.name) : null);

  // With auth, every API, MCP and terminal call needs a principal; the principal is the actor.
  type Handler = (req: any, server: any) => Response | Promise<Response> | undefined | Promise<Response | undefined>;
  const guard = (h: (req: any, server: any, who: Principal | null) => ReturnType<Handler>): Handler => (req, srv) => {
    if (!auth) return h(req, srv, null);
    const who = auth.principal(req);
    return who ? h(req, srv, who) : unauthorized();
  };

  // Every socket starts a PTY process, so the number open at once is capped. A slot is taken at the
  // upgrade and given back when the socket closes.
  const maxViewers = opts.maxViewers ?? MAX_VIEWERS;
  if (!Number.isSafeInteger(maxViewers) || maxViewers < 1) throw new Error("maxViewers must be a positive integer");
  let viewers = 0;
  // Open terminal sockets, so a token reload can close the ones whose token was revoked or rotated.
  const sockets = new Set<{ data: SocketData; close(code?: number, reason?: string): void }>();
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
    if (viewers >= maxViewers) {
      if (server.upgrade(req, { data: { session, ...size, busy: true } })) return undefined;
      return Response.json({ error: { kind: "busy", message: "too many open terminal viewers" } }, { status: 503 });
    }
    if (server.upgrade(req, { data: { session, ...size, principal: who ?? undefined } })) { viewers++; return undefined; }
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
      "/api/whoami": { GET: guard((_req, _s, who) => Response.json({ principal: who?.name ?? null, auth: Boolean(auth) })) },
      "/api/sessions": { GET: guard(() => app.sessions()) },
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
      // Streamable HTTP MCP endpoint. DNS rebinding protection admits only the configured Host headers.
      "/mcp": guard(async (req, _s, who) => {
        if (!control) return noControl();
        if (!originAllowed(req)) return forbidden();
        const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`, ...(isLoopback(hostname) ? [] : [`${hostname}:${server.port}`]), ...(opts.allowedHosts ?? [])];
        return handleMcp(req, control, hosts, who?.name);
      }),
      // Read-only terminal stream. The socket accepts no messages at all: input would be typing and
      // a resize would resize the agent's window, since the viewer may be its only tmux client.
      "/api/sessions/:name/terminal": { GET: guard((req, server, who) => openTerminal(req, server, who, req.params.name)) },
      // Same stream with the session in the query, so a proxy that routes WebSocket upgrades by exact
      // path (the DeepSeek Harness panel) can carry every session over one path.
      "/api/terminal": { GET: guard((req, server, who) => openTerminal(req, server, who, new URL(req.url).searchParams.get("session") ?? "")) },
    },
    websocket: {
      async open(ws) {
        if (ws.data.busy) return ws.close(1013, BUSY_REASON);
        sockets.add(ws);
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
      message(ws) {
        ws.close(1008, "read-only terminal: client messages are not accepted");
      },
      close(ws) {
        if (ws.data.busy) return;
        if (!ws.data.closed) viewers--;
        sockets.delete(ws);
        ws.data.closed = true;
        ws.data.viewer?.close();
      },
    },
    fetch: () => Response.json({ error: { kind: "not_found", message: "not found" } }, { status: 404 }),
  });
  // A stopped server must not stay subscribed to a shared Auth, or every later reload still reaches it.
  // Some tests replace Bun.serve with a stub that has no stop.
  if (unsubscribe && typeof server?.stop === "function") {
    const stop = server.stop.bind(server);
    server.stop = (force?: boolean) => { unsubscribe(); return stop(force); };
  }
  return server;
}
