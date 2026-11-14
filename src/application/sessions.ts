// Reads the fleet's sessions and says which model each one runs. Runtime truth comes from the fleet;
// storage only keeps registrations and observation history.
import type { Store } from "../data/store.ts";
import type { FleetReader } from "../domain/fleet.ts";
import { modelState, type ModelObserver, type ModelState, type Observation, type SessionKind } from "../domain/model.ts";

const unknownReason: Record<Exclude<Observation["kind"], "observed">, string> = {
  no_turn_yet: "agent running, no main-thread turn yet",
  no_agent_process: "no claude process in this session",
  unavailable: "model metadata unavailable",
  malformed: "model metadata malformed",
};

export type SessionView = {
  name: string;
  host: string | null;
  role: string | null;
  registered: boolean;
  running: boolean;
  contextPct: number | null;
  model: ModelState;
};

export function sessionReader(deps: { fleet: FleetReader; store: Store; now?: () => Date; observer?: ModelObserver }) {
  const now = deps.now ?? (() => new Date());
  const known = () => new Map(deps.store.sessions().map((s) => [s.name, s]));

  // Runs a fresh observation for this read; storage only keeps history.
  async function modelFor(name: string, kind: SessionKind, configuredModel: string | null, running: boolean): Promise<ModelState> {
    if (kind === "script") return { state: "not_applicable" };
    let runtimeInstance: string | null = null;
    let reason: string | undefined = running ? "no model observer configured" : "session not running";
    if (deps.observer && running) {
      let o: Observation;
      try {
        o = await deps.observer.observe(name);
      } catch {
        o = { kind: "unavailable", reason: "observer failed" };
      }
      if (o.kind === "observed") {
        runtimeInstance = o.runtimeInstance;
        reason = undefined;
        const last = deps.store.latestObservation(name);
        if (!last || last.runtimeInstance !== o.observation.runtimeInstance || last.observedAt !== o.observation.observedAt || last.model !== o.observation.model) {
          deps.store.recordObservation(name, o.observation);
        }
      } else {
        if (o.kind === "no_turn_yet") runtimeInstance = o.runtimeInstance;
        reason = "reason" in o ? `${unknownReason[o.kind]}: ${o.reason}` : unknownReason[o.kind];
      }
    }
    return modelState({ kind, configuredModel, observation: deps.store.latestObservation(name), runtimeInstance, now: now(), reason });
  }

  return {
    async list(): Promise<SessionView[]> {
      const status = await deps.fleet.status();
      const records = known();
      return Promise.all(status.sessions.map(async (s) => {
        const rec = records.get(s.name);
        // Unregistered sessions in a fleet are agents unless registered as scripts.
        const model = await modelFor(s.name, rec?.kind ?? "agent", rec?.configuredModel ?? null, s.running);
        return {
          name: s.name,
          host: rec?.host ?? null,
          role: rec?.role ?? null,
          registered: Boolean(rec),
          running: s.running,
          contextPct: s.contextPct,
          model,
        };
      }));
    },

    screen(name: string, lines: number): Promise<string> {
      return deps.fleet.screen(name, lines);
    },
  };
}
