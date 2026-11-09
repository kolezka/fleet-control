// Read-only Fleet Control host service skeleton. Localhost only; no auth yet, so never bind it elsewhere.
import { FleetError, type FleetReader } from "./fleet/cli.ts";
import { modelState } from "./model.ts";
import type { Store } from "./store.ts";
import deck from "../web/index.html";
import { clampSize, openViewer, type Viewer } from "./terminal/viewer.ts";
import { CommandError, type Commands } from "./commands.ts";
import type { Deliverer } from "./delivery.ts";
import { handleMcp } from "./mcp.ts";

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

export function createApp(deps: { fleet: FleetReader; store: Store; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const known = () => new Map(deps.store.sessions().map((s) => [s.name, s]));

  return {
    async sessions(): Promise<Response> {
      try {
        const status = await deps.fleet.status();
        const records = known();
        const sessions = status.sessions.map((s) => {
          const rec = records.get(s.name);
          // The fleet CLI does not expose a runtime instance yet, so observations cannot be bound to one.
          const model = rec
            ? modelState({
                kind: rec.kind,
                configuredModel: rec.configuredModel,
                observation: deps.store.latestObservation(s.name),
                runtimeInstance: null,
                now: now(),
              })
            : { state: "unknown" as const, lastObserved: null };
          return {
            name: s.name,
            host: rec?.host ?? null,
            role: rec?.role ?? null,
            registered: Boolean(rec),
            running: s.running,
            contextPct: s.contextPct,
            model,
          };
        });
        return Response.json({ sessions, source: "fleet status", readAt: now().toISOString() });
      } catch (e) {
        return errorResponse(e);
      }
    },

    async screen(name: string, lines: number): Promise<Response> {
      try {
        const text = await deps.fleet.screen(name, lines);
        return Response.json({ session: name, text, source: "fleet screen", readAt: now().toISOString() });
      } catch (e) {
        return errorResponse(e);
      }
    },
  };
}

type TerminalDeps = { fleetBin: string; confPath: string };
type ControlDeps = { commands: Commands; deliverer: Deliverer };

const commandStatus: Record<CommandError["kind"], number> = { not_found: 404, conflict: 409, invalid: 400 };
function commandError(e: unknown): Response {
  if (e instanceof CommandError) return Response.json({ error: { kind: e.kind, message: e.message } }, { status: commandStatus[e.kind] });
  return Response.json({ error: { kind: "internal", message: "internal error" } }, { status: 500 });
}
const forbidden = () => Response.json({ error: { kind: "forbidden", message: "cross-origin request" } }, { status: 403 });
const noControl = () => Response.json({ error: { kind: "unavailable", message: "command queue not configured" } }, { status: 503 });

// Writes from a browser must come from a page this service served. MCP clients send no Origin.
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin === null || origin === new URL(req.url).origin;
}
type SocketData = { session: string; cols: number; rows: number; viewer?: Viewer; closed?: boolean };

// Browsers send Origin on WebSocket upgrades; only pages served by this service may open a terminal.
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && origin === new URL(req.url).origin;
}

type Routes = "/" | "/api/sessions" | "/api/sessions/:name/screen" | "/api/sessions/:name/terminal" | "/api/commands" | "/api/commands/:id" | "/mcp";

export function serve(deps: Parameters<typeof createApp>[0] & { terminal?: TerminalDeps; control?: ControlDeps }, port = 4871) {
  const app = createApp(deps);
  const terminal = deps.terminal;
  const control = deps.control;
  const server: ReturnType<typeof Bun.serve<SocketData, Routes>> = Bun.serve<SocketData, Routes>({
    hostname: "127.0.0.1",
    port,
    routes: {
      "/": deck,
      "/api/sessions": { GET: () => app.sessions() },
      "/api/sessions/:name/screen": {
        GET: (req) => {
          const raw = new URL(req.url).searchParams.get("lines");
          const lines = raw === null ? 40 : Number(raw);
          return app.screen(req.params.name, lines);
        },
      },
      // The web UI reads and queues commands here; MCP clients use /mcp. Both share one queue.
      "/api/commands": {
        GET: () => (control ? Response.json({ commands: control.commands.list() }) : noControl()),
        POST: async (req) => {
          if (!control) return noControl();
          if (!originAllowed(req)) return forbidden();
          try {
            const body = (await req.json()) as Record<string, unknown>;
            const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
            const { command, created } = control.commands.submit({
              idempotencyKey: str("idempotencyKey"),
              target: str("target"),
              actor: str("actor") || "web-ui",
              text: str("text"),
            });
            const after = created ? await control.deliverer.deliver(command.id) : command;
            return Response.json({ command: after, created, events: control.commands.events(command.id) }, { status: created ? 201 : 200 });
          } catch (e) {
            if (e instanceof SyntaxError) return Response.json({ error: { kind: "invalid", message: "body is not JSON" } }, { status: 400 });
            return commandError(e);
          }
        },
      },
      "/api/commands/:id": {
        GET: (req) => {
          if (!control) return noControl();
          try {
            return Response.json({ command: control.commands.get(req.params.id), events: control.commands.events(req.params.id) });
          } catch (e) {
            return commandError(e);
          }
        },
      },
      // Streamable HTTP MCP endpoint. DNS rebinding protection only admits loopback Host headers.
      "/mcp": async (req) => {
        if (!control) return noControl();
        if (!originAllowed(req)) return forbidden();
        return handleMcp(req, control, [`127.0.0.1:${server.port}`, `localhost:${server.port}`]);
      },
      // Read-only terminal stream. The socket accepts no messages at all: input would be typing and
      // a resize would resize the agent's window, since the viewer may be its only tmux client.
      "/api/sessions/:name/terminal": {
        GET: (req, server) => {
          if (!terminal) return Response.json({ error: { kind: "unavailable", message: "terminal viewer not configured" } }, { status: 503 });
          if (!sameOrigin(req)) return Response.json({ error: { kind: "forbidden", message: "cross-origin terminal request" } }, { status: 403 });
          const url = new URL(req.url);
          const size = clampSize(Number(url.searchParams.get("cols") ?? 80), Number(url.searchParams.get("rows") ?? 24));
          if (!size || !/^[A-Za-z0-9._-]+$/.test(req.params.name)) {
            return Response.json({ error: { kind: "invalid_name", message: "bad session name or size" } }, { status: 400 });
          }
          if (server.upgrade(req, { data: { session: req.params.name, ...size } })) return undefined;
          return Response.json({ error: { kind: "upgrade_failed", message: "expected a WebSocket upgrade" } }, { status: 400 });
        },
      },
    },
    websocket: {
      async open(ws) {
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
        ws.data.closed = true;
        ws.data.viewer?.close();
      },
    },
    fetch: () => Response.json({ error: { kind: "not_found", message: "not found" } }, { status: 404 }),
  });
  return server;
}
