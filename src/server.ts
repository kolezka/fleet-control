// Read-only Fleet Control host service skeleton. Localhost only; no auth yet, so never bind it elsewhere.
import { FleetError, type FleetReader } from "./fleet/cli.ts";
import { modelState } from "./model.ts";
import type { Store } from "./store.ts";

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

export function serve(deps: Parameters<typeof createApp>[0], port = 4871) {
  const app = createApp(deps);
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    routes: {
      "/api/sessions": { GET: () => app.sessions() },
      "/api/sessions/:name/screen": {
        GET: (req) => {
          const raw = new URL(req.url).searchParams.get("lines");
          const lines = raw === null ? 40 : Number(raw);
          return app.screen(req.params.name, lines);
        },
      },
    },
    fetch: () => Response.json({ error: { kind: "not_found", message: "not found" } }, { status: 404 }),
  });
}
