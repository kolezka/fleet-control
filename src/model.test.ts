import { expect, test } from "bun:test";
import { modelState } from "./model.ts";

const now = new Date("2026-11-09T12:00:00Z");
const obs = { model: "claude-x", source: "test-fixture", observedAt: "2026-11-09T11:58:00Z", runtimeInstance: "i1" };

test("a script session has no model", () => {
  expect(modelState({ kind: "script", configuredModel: "claude-x", observation: obs, runtimeInstance: "i1", now }))
    .toEqual({ state: "not_applicable" });
});

test("an uninstrumented agent is unknown, not 'no model'", () => {
  expect(modelState({ kind: "agent", configuredModel: null, observation: null, runtimeInstance: null, now }))
    .toEqual({ state: "unknown", lastObserved: null });
});

test("configuration alone is labelled configured, never observed", () => {
  expect(modelState({ kind: "agent", configuredModel: "opus", observation: null, runtimeInstance: "i1", now }))
    .toEqual({ state: "configured", model: "opus", note: "configured, not observed" });
});

test("a fresh observation for the same runtime instance is observed with provenance", () => {
  expect(modelState({ kind: "agent", configuredModel: "opus", observation: obs, runtimeInstance: "i1", now }))
    .toEqual({ state: "observed", model: "claude-x", source: "test-fixture", observedAt: obs.observedAt });
});

test("an observation from a replaced instance is stale history", () => {
  expect(modelState({ kind: "agent", configuredModel: "opus", observation: obs, runtimeInstance: "i2", now }))
    .toEqual({ state: "unknown", lastObserved: obs });
});

test("an old turn of the live instance stays observed and keeps its own time", () => {
  const later = new Date("2026-11-09T13:00:00Z");
  expect(modelState({ kind: "agent", configuredModel: null, observation: obs, runtimeInstance: "i1", now: later }))
    .toEqual({ state: "observed", model: "claude-x", source: "test-fixture", observedAt: obs.observedAt });
});

test("a turn time in the future is not trusted", () => {
  const future = { ...obs, observedAt: "2026-11-09T13:00:00Z" };
  expect(modelState({ kind: "agent", configuredModel: null, observation: future, runtimeInstance: "i1", now }).state)
    .toBe("unknown");
});

test("the reason for an unknown model is kept", () => {
  expect(modelState({ kind: "agent", configuredModel: null, observation: obs, runtimeInstance: null, now, reason: "no agent process" }))
    .toEqual({ state: "unknown", lastObserved: obs, reason: "no agent process" });
});

test("an unknown runtime instance cannot confirm an observation", () => {
  expect(modelState({ kind: "agent", configuredModel: null, observation: obs, runtimeInstance: null, now }).state)
    .toBe("unknown");
});
