import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralRequests } from "./requests.ts";

const run = { id: "run-1", orchestrator: "owner", phase: "plan", revision: 1, phaseStatus: "planned", updatedAt: "2026-01-01T00:00:00.000Z" };
const request = { id: "req-1", runId: "run-1", phase: "plan", revision: 1, kind: "approval", question: "Original?", proposedAction: "", scope: "", evidence: "[]", allowedResponses: '["approve","decline"]', blocking: true, origin: "owner", status: "open", response: null as string | null, resolvedBy: null, resolutionNote: null, resolvedAt: null, createdAt: run.updatedAt };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function fixture(pause?: { match: string; entered: () => void; resume: Promise<void> }, requestRow = request) {
  const calls: { query: string; values: unknown[] }[] = [];
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    calls.push({ query, values });
    if (pause && query.includes(pause.match)) {
      pause.entered();
      await pause.resume;
    }
    if (query.includes("SELECT id, orchestrator, phase, revision")) return [run];
    if (query.includes("SELECT id, run_id AS")) return [requestRow];
    if (query.includes("UPDATE central_requests SET status = 'stale'")) return [];
    return [];
  };
  const db = Object.assign(sql, { begin: async (callback: (tx: typeof sql) => Promise<unknown>) => callback(sql) });
  return { store: new CentralRequests(db as unknown as SQL, () => new Date(run.updatedAt)), calls };
}

function call(calls: { query: string; values: unknown[] }[], query: string) {
  const found = calls.find((item) => item.query.includes(query));
  if (!found) throw new Error(`Missing SQL: ${query}`);
  return found.values;
}

test("create accepts input fields provided by prototype getters", async () => {
  class Input {
    get runId() { return "run-1"; }
    get origin() { return "owner"; }
    get expectedRevision() { return 1; }
    get kind() { return "approval" as const; }
    get question() { return "Getter question?"; }
    get evidence() { return ["getter evidence"]; }
    get allowedResponses() { return ["approve", "decline"]; }
    get blocking() { return false; }
  }
  const { store, calls } = fixture();
  await store.create(new Input());
  expect(call(calls, "INSERT INTO central_requests (").slice(4, 11)).toEqual([
    "approval", "Getter question?", "", "", '["getter evidence"]', '["approve","decline"]', false,
  ]);
});

test("create snapshots scalar and array inputs before an async guard", async () => {
  const entered = deferred(), resume = deferred();
  const { store, calls } = fixture();
  const input = { runId: "run-1", origin: "owner", expectedRevision: 1, kind: "approval" as const, question: "Original?", proposedAction: "original action", scope: "original scope", evidence: ["original evidence"], allowedResponses: ["approve", "decline"], blocking: true };
  const pending = store.create(input, async () => { entered.release(); await resume.promise; });
  await entered.promise;
  input.question = "Changed?";
  input.proposedAction = "changed action";
  input.scope = "changed scope";
  input.evidence[0] = "changed evidence";
  input.allowedResponses.push("changed");
  input.blocking = false;
  resume.release();
  await pending;
  const values = call(calls, "INSERT INTO central_requests (");
  expect(values.slice(4, 11)).toEqual(["approval", "Original?", "original action", "original scope", '["original evidence"]', '["approve","decline"]', true]);
});

test("updatePhase snapshots authorization and phase fields before an async guard", async () => {
  const entered = deferred(), resume = deferred();
  const { store, calls } = fixture();
  const input = { runId: "run-1", actor: "owner", expectedRevision: 1, phase: "build", phaseStatus: "running", newRevision: true };
  const pending = store.updatePhase(input, async () => { entered.release(); await resume.promise; });
  await entered.promise;
  Object.assign(input, { runId: "other", actor: "intruder", expectedRevision: 99, phase: "changed", phaseStatus: "changed", newRevision: false });
  resume.release();
  await pending;
  expect(call(calls, "UPDATE central_runs SET phase").slice(0, 3)).toEqual(["build", 2, "running"]);
  expect(call(calls, "INSERT INTO central_request_events").slice(3, 5)).toEqual(["owner", "build r2 running"]);
});

test("resolve uses the original response and note after SQL yields", async () => {
  const entered = deferred(), resume = deferred();
  const { store, calls } = fixture({ match: "UPDATE central_requests SET status = 'resolved'", entered: entered.release, resume: resume.promise });
  const input = { requestId: "req-1", actor: "operator", response: "approve", expectedRevision: 1, note: "original note" };
  const pending = store.resolve(input);
  await entered.promise;
  input.response = "decline";
  input.note = "changed note";
  resume.release();
  await pending;
  expect(call(calls, "UPDATE central_requests SET status = 'resolved'").slice(0, 3)).toEqual(["approve", "operator", "original note"]);
  expect(call(calls, "INSERT INTO central_request_events").slice(3, 5)).toEqual(["operator", "approve: original note"]);
});

test("acknowledge snapshots request and actor before an async guard", async () => {
  const entered = deferred(), resume = deferred();
  const { store, calls } = fixture(undefined, { ...request, status: "resolved", response: "approve" });
  const input = { requestId: "req-1", actor: "owner" };
  const pending = store.acknowledge(input, async () => { entered.release(); await resume.promise; });
  await entered.promise;
  Object.assign(input, { requestId: "other", actor: "intruder" });
  resume.release();
  await pending;
  expect(call(calls, 'SELECT id, run_id AS')[0]).toBe("req-1");
  expect(call(calls, "UPDATE central_requests SET status =")).toEqual(["acknowledged", "req-1"]);
  expect(call(calls, "INSERT INTO central_request_events").slice(0, 5)).toEqual(["req-1", "run-1", "acknowledged", "owner", 'read answer "approve"']);
});

test("withdraw snapshots request, actor and reason before an async guard", async () => {
  const entered = deferred(), resume = deferred();
  const { store, calls } = fixture();
  const input = { requestId: "req-1", actor: "owner", reason: "original reason" };
  const pending = store.withdraw(input, async () => { entered.release(); await resume.promise; });
  await entered.promise;
  Object.assign(input, { requestId: "other", actor: "intruder", reason: "changed reason" });
  resume.release();
  await pending;
  expect(call(calls, 'SELECT id, run_id AS')[0]).toBe("req-1");
  expect(call(calls, "UPDATE central_requests SET status =")).toEqual(["withdrawn", "req-1"]);
  expect(call(calls, "INSERT INTO central_request_events").slice(0, 5)).toEqual(["req-1", "run-1", "withdrawn", "owner", "original reason"]);
});

test("registerRun snapshots phase before an async guard", async () => {
  const entered = deferred(), resume = deferred();
  const calls: { query: string; values: unknown[] }[] = [];
  const input = { runId: "new-run", orchestrator: "owner", phase: "plan" };
  // This case uses a separate SQL stub because the common fixture models an existing run.
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?"); calls.push({ query, values });
    if (query.includes("SELECT id, orchestrator, phase, revision")) return query.includes("FOR UPDATE") ? [] : [{ ...run, id: "new-run" }];
    return [];
  };
  const db = Object.assign(sql, { begin: async (callback: (tx: typeof sql) => Promise<unknown>) => callback(sql) });
  const pending = new CentralRequests(db as unknown as SQL).registerRun(input, async () => { entered.release(); await resume.promise; });
  await entered.promise;
  input.phase = "changed";
  resume.release();
  await pending;
  expect(call(calls, "INSERT INTO central_runs VALUES")[2]).toBe("plan");
});
