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
  | { state: "unknown"; lastObserved: ModelObservation | null }
  | { state: "not_applicable" };

export const observationMaxAgeMs = 10 * 60 * 1000;

// Shows the strongest supported fact. A configured value never becomes "observed",
// and an observation from another runtime instance or older than the limit is stale.
export function modelState(input: {
  kind: SessionKind;
  configuredModel: string | null;
  observation: ModelObservation | null;
  runtimeInstance: string | null;
  now: Date;
}): ModelState {
  if (input.kind === "script") return { state: "not_applicable" };
  const o = input.observation;
  if (o && input.runtimeInstance && o.runtimeInstance === input.runtimeInstance) {
    const age = input.now.getTime() - Date.parse(o.observedAt);
    if (Number.isFinite(age) && age >= 0 && age <= observationMaxAgeMs) {
      return { state: "observed", model: o.model, source: o.source, observedAt: o.observedAt };
    }
  }
  if (o) return { state: "unknown", lastObserved: o };
  if (input.configuredModel) return { state: "configured", model: input.configuredModel, note: "configured, not observed" };
  return { state: "unknown", lastObserved: null };
}
