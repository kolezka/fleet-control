import { expect, test } from "bun:test";
import { Requests } from "../data/requests.ts";
import { Store } from "../data/store.ts";
import { requestUseCases } from "./requests.ts";

const store = () => new Requests(new Store(":memory:").db);

// A recording stand-in: which store method got which input.
function recording() {
  const calls: unknown[][] = [];
  const requests = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => { calls.push([name, ...args]); return name; } }) as unknown as Requests;
  return { calls, requests };
}

test("without an authenticated caller the declared names are used as given", () => {
  const { calls, requests } = recording();
  const use = requestUseCases(requests);
  use.registerRun({ runId: "run", orchestrator: "orch", phase: "plan" });
  use.updatePhase({ runId: "run", actor: "orch", expectedRevision: 1, phaseStatus: "working", newRevision: false });
  use.create({ runId: "run", origin: "orch", expectedRevision: 1, kind: "approval", question: "ok?" });
  use.resolve({ requestId: "r", response: "yes", actor: "human", expectedRevision: 1 });
  use.acknowledge({ requestId: "r", actor: "orch" });
  use.withdraw({ requestId: "r", actor: "orch", reason: "done" });
  expect(calls).toEqual([
    ["registerRun", { runId: "run", orchestrator: "orch", phase: "plan" }],
    ["updatePhase", { runId: "run", actor: "orch", expectedRevision: 1, phaseStatus: "working", newRevision: false }],
    ["create", { runId: "run", origin: "orch", expectedRevision: 1, kind: "approval", question: "ok?" }],
    ["resolve", { requestId: "r", response: "yes", actor: "human", expectedRevision: 1 }],
    ["acknowledge", { requestId: "r", actor: "orch" }],
    ["withdraw", { requestId: "r", actor: "orch", reason: "done" }],
  ]);
});

test("an authenticated caller replaces the orchestrator, actor and origin of every write", () => {
  const { calls, requests } = recording();
  const use = requestUseCases(requests, "token-holder");
  use.registerRun({ runId: "run", orchestrator: "orch", phase: "plan" });
  use.updatePhase({ runId: "run", actor: "orch", expectedRevision: 1, phaseStatus: "working", newRevision: false });
  use.create({ runId: "run", origin: "orch", expectedRevision: 1, kind: "approval", question: "ok?" });
  use.resolve({ requestId: "r", response: "yes", actor: "human", expectedRevision: 1 });
  use.acknowledge({ requestId: "r", actor: "orch" });
  use.withdraw({ requestId: "r", actor: "orch", reason: "done" });
  expect(calls.map(([name, input]) => [name, (input as Record<string, unknown>).orchestrator ?? (input as Record<string, unknown>).actor ?? (input as Record<string, unknown>).origin])).toEqual([
    ["registerRun", "token-holder"], ["updatePhase", "token-holder"], ["create", "token-holder"],
    ["resolve", "token-holder"], ["acknowledge", "token-holder"], ["withdraw", "token-holder"],
  ]);
});

test("a caller with another token cannot write the phase record of a run it did not register", () => {
  const requests = store();
  requestUseCases(requests, "orchestrator").registerRun({ runId: "run", orchestrator: "ignored", phase: "plan" });
  const worker = requestUseCases(requests, "worker");
  expect(() => worker.updatePhase({ runId: "run", actor: "orchestrator", expectedRevision: 1, phaseStatus: "done", newRevision: false })).toThrow("worker is not the orchestrator of run");
  expect(requests.run("run").orchestrator).toBe("orchestrator");
});

test("the overview shows the runs next to the requests, with the same filter the list takes", () => {
  const requests = store();
  const use = requestUseCases(requests);
  use.registerRun({ runId: "run-a", orchestrator: "orch", phase: "plan" });
  use.registerRun({ runId: "run-b", orchestrator: "orch", phase: "plan" });
  const a = use.create({ runId: "run-a", origin: "orch", expectedRevision: 1, kind: "approval", question: "a?" });
  const b = use.create({ runId: "run-b", origin: "orch", expectedRevision: 1, kind: "blocker", question: "b?" });
  expect(use.overview().runs.map((run) => run.id).sort()).toEqual(["run-a", "run-b"]);
  expect(use.overview().requests.map((request) => request.id).sort()).toEqual([a.id, b.id].sort());
  const filtered = use.overview({ runId: "run-b" });
  expect(filtered.requests.map((request) => request.id)).toEqual([b.id]);
  expect(filtered.runs).toHaveLength(2);
});

test("the gate and the event cursor read what the store recorded", () => {
  const requests = store();
  const use = requestUseCases(requests);
  use.registerRun({ runId: "run", orchestrator: "orch", phase: "plan" });
  const request = use.create({ runId: "run", origin: "orch", expectedRevision: 1, kind: "approval", question: "ok?" });
  expect(use.gate("run", "plan", 1).approved).toBe(false);
  use.resolve({ requestId: request.id, response: "approve", actor: "human", expectedRevision: 1 });
  expect(use.gate("run", "plan", 1)).toEqual(requests.gate("run", "plan", 1));
  const events = use.eventsAfter(0);
  expect(events).toEqual(requests.events(0));
  expect(use.eventsAfter(events.at(-1)!.seq)).toEqual([]);
});
