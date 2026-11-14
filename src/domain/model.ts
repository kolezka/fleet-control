// Session model visibility. See docs/model-observability.md.

export type SessionKind = "agent" | "script";

export type ModelObservation = {
  model: string;
  source: string;
  observedAt: string; // ISO time
  runtimeInstance: string;
};

export type ModelState =
  | { state: "observed"; model: string; source: string; observedAt: string }
  | { state: "configured"; model: string; note: "configured, not observed" }
  | { state: "unknown"; lastObserved: ModelObservation | null; reason?: string }
  | { state: "not_applicable" };

// Freshness: an observation is current only while its runtime instance is verified alive
// *now* (runtimeInstance comes from a check made for this request, never from storage).
// observedAt is the time of the last main-thread turn, shown so an old turn reads as old.
// It is not the model of a turn that has not happened yet.
export function modelState(input: {
  kind: SessionKind;
  configuredModel: string | null;
  observation: ModelObservation | null;
  runtimeInstance: string | null;
  now: Date;
  reason?: string; // why the current instance could not be observed
}): ModelState {
  if (input.kind === "script") return { state: "not_applicable" };
  const o = input.observation;
  if (o && input.runtimeInstance && o.runtimeInstance === input.runtimeInstance) {
    const age = input.now.getTime() - Date.parse(o.observedAt);
    // a turn time in the future is broken metadata, not an observation
    if (Number.isFinite(age) && age >= -60_000) {
      return { state: "observed", model: o.model, source: o.source, observedAt: o.observedAt };
    }
  }
  const reason = input.reason ? { reason: input.reason } : {};
  if (o) return { state: "unknown", lastObserved: o, ...reason };
  if (input.configuredModel) return { state: "configured", model: input.configuredModel, note: "configured, not observed" };
  return { state: "unknown", lastObserved: null, ...reason };
}

// Outcomes stay distinct: "no process" and "malformed metadata" must not look alike.
export type Observation =
  | { kind: "observed"; runtimeInstance: string; observation: ModelObservation }
  | { kind: "no_turn_yet"; runtimeInstance: string }
  | { kind: "no_agent_process" }
  | { kind: "unavailable"; reason: string }
  | { kind: "malformed"; runtimeInstance: string | null; reason: string };

export type ModelObserver = { observe(session: string): Promise<Observation> };
