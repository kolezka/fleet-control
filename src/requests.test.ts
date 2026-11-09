import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { RequestError, Requests } from "./requests.ts";

const db = () => new Database(":memory:", { strict: true });
function setup() {
  const r = new Requests(db());
  r.registerRun({ runId: "run-1", orchestrator: "supervisor", phase: "phase-2" });
  return r;
}
const ask = (r: Requests, revision = 1) =>
  r.create({ runId: "run-1", origin: "supervisor", expectedRevision: revision, kind: "approval", question: "Start phase 3?" });

test("a request records run, phase and revision and defaults to approve/decline", () => {
  const r = setup();
  const q = ask(r);
  expect(q).toMatchObject({ runId: "run-1", phase: "phase-2", revision: 1, status: "open", blocking: true, allowedResponses: ["approve", "decline"] });
});

test("silence is not approval: an open request does not open the gate", () => {
  const r = setup();
  expect(r.gate("run-1", "phase-2", 1).approved).toBe(false);
  ask(r);
  expect(r.gate("run-1", "phase-2", 1)).toMatchObject({ approved: false, reason: "approval requested, no answer yet" });
});

test("approval applies only to its own phase and revision", () => {
  const r = setup();
  const q = ask(r);
  r.resolve({ requestId: q.id, response: "approve", actor: "mariusz", expectedRevision: 1 });
  expect(r.gate("run-1", "phase-2", 1).approved).toBe(true);
  expect(r.gate("run-1", "phase-2", 2).approved).toBe(false);
  expect(r.gate("run-1", "phase-3", 1).approved).toBe(false);
});

test("a new revision makes open requests stale and they cannot be answered", () => {
  const r = setup();
  const q = ask(r);
  const { run, staled } = r.updatePhase({ runId: "run-1", actor: "supervisor", expectedRevision: 1, phaseStatus: "fix round 1", newRevision: true });
  expect(run.revision).toBe(2);
  expect(staled).toEqual([q.id]);
  expect(() => r.resolve({ requestId: q.id, response: "approve", actor: "mariusz", expectedRevision: 1 })).toThrow(/stale/);
  expect(r.gate("run-1", "phase-2", 2).approved).toBe(false);
});

test("an approval of an old revision does not carry over to the new one", () => {
  const r = setup();
  const q = ask(r);
  r.resolve({ requestId: q.id, response: "approve", actor: "mariusz", expectedRevision: 1 });
  r.updatePhase({ runId: "run-1", actor: "supervisor", expectedRevision: 1, phaseStatus: "changed after approval", newRevision: true });
  expect(r.gate("run-1", "phase-2", 2)).toMatchObject({ approved: false, reason: "no approval request for this revision" });
});

test("an answer naming the wrong revision is refused", () => {
  const r = setup();
  const q = ask(r);
  expect(() => r.resolve({ requestId: q.id, response: "approve", actor: "mariusz", expectedRevision: 2 })).toThrow(/revision 1/);
  expect(r.get(q.id).status).toBe("open");
});

test("two different answers conflict visibly; the first one stands", () => {
  const r = setup();
  const q = ask(r);
  r.resolve({ requestId: q.id, response: "approve", actor: "web-ui", expectedRevision: 1 });
  const err = (() => { try { r.resolve({ requestId: q.id, response: "decline", actor: "macbook-session", expectedRevision: 1 }); } catch (e) { return e; } })();
  expect(err).toBeInstanceOf(RequestError);
  expect((err as RequestError).kind).toBe("conflict");
  expect((err as Error).message).toMatch(/already answered "approve" by web-ui/);
  expect(r.get(q.id).response).toBe("approve");
  // the identical answer retried is fine
  expect(r.resolve({ requestId: q.id, response: "approve", actor: "web-ui", expectedRevision: 1 }).status).toBe("resolved");
});

test("decline closes the gate and responses outside the allowed list are refused", () => {
  const r = setup();
  const q = ask(r);
  expect(() => r.resolve({ requestId: q.id, response: "yes please", actor: "mariusz", expectedRevision: 1 })).toThrow(/one of approve, decline/);
  r.resolve({ requestId: q.id, response: "decline", actor: "mariusz", expectedRevision: 1, note: "tests are red" });
  expect(r.gate("run-1", "phase-2", 1)).toMatchObject({ approved: false, reason: "declined by mariusz" });
});

test("only the registered orchestrator writes phase state, asks, acknowledges or withdraws", () => {
  const r = setup();
  expect(() => r.registerRun({ runId: "run-1", orchestrator: "intruder", phase: "x" })).toThrow(/belongs to orchestrator supervisor/);
  expect(() => r.updatePhase({ runId: "run-1", actor: "worker", expectedRevision: 1, phaseStatus: "done", newRevision: false })).toThrow(/not the orchestrator/);
  expect(() => r.create({ runId: "run-1", origin: "worker", expectedRevision: 1, kind: "approval", question: "?" })).toThrow(/not the orchestrator/);
  const q = ask(r);
  r.resolve({ requestId: q.id, response: "approve", actor: "mariusz", expectedRevision: 1 });
  expect(() => r.acknowledge({ requestId: q.id, actor: "web-ui" })).toThrow(/not the orchestrator/);
  expect(r.acknowledge({ requestId: q.id, actor: "supervisor" }).status).toBe("acknowledged");
});

test("two writers racing on the phase record: the second gets a revision conflict", () => {
  const r = setup();
  r.updatePhase({ runId: "run-1", actor: "supervisor", expectedRevision: 1, phaseStatus: "review", newRevision: true });
  expect(() => r.updatePhase({ runId: "run-1", actor: "supervisor", expectedRevision: 1, phaseStatus: "verified", newRevision: false })).toThrow(/revision 2, not 1/);
});

test("a status update without new work keeps the revision and the open request", () => {
  const r = setup();
  const q = ask(r);
  const { run, staled } = r.updatePhase({ runId: "run-1", actor: "supervisor", expectedRevision: 1, phaseStatus: "waiting for approval", newRevision: false });
  expect(run.revision).toBe(1);
  expect(staled).toEqual([]);
  expect(r.get(q.id).status).toBe("open");
});

test("moving to another phase is a new revision", () => {
  const r = setup();
  const { run } = r.updatePhase({ runId: "run-1", actor: "supervisor", expectedRevision: 1, phase: "phase-3", phaseStatus: "started", newRevision: false });
  expect(run).toMatchObject({ phase: "phase-3", revision: 2 });
});

test("acknowledgement requires an answer and is not phase progress", () => {
  const r = setup();
  const q = ask(r);
  expect(() => r.acknowledge({ requestId: q.id, actor: "supervisor" })).toThrow(/only a resolved request/);
  r.resolve({ requestId: q.id, response: "approve", actor: "mariusz", expectedRevision: 1 });
  r.acknowledge({ requestId: q.id, actor: "supervisor" });
  expect(r.run("run-1")).toMatchObject({ phase: "phase-2", revision: 1, phaseStatus: "planned" });
});

test("requests and answers survive a restart; nothing is approved by the restart", async () => {
  const dir = await (await import("node:fs/promises")).mkdtemp(`${(await import("node:os")).tmpdir()}/fleet-control-req-`);
  const path = `${dir}/state.db`;
  const a = new Requests(new Database(path, { strict: true }));
  a.registerRun({ runId: "run-1", orchestrator: "supervisor", phase: "phase-2" });
  const q = a.create({ runId: "run-1", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Start phase 3?" });
  const b = new Requests(new Database(path, { strict: true }));
  expect(b.get(q.id).status).toBe("open");
  expect(b.gate("run-1", "phase-2", 1).approved).toBe(false);
  await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
});

test("events record who did what", () => {
  const r = setup();
  const q = ask(r);
  r.resolve({ requestId: q.id, response: "decline", actor: "mariusz", expectedRevision: 1 });
  expect(r.events().map((e) => `${e.kind}:${e.actor}`)).toEqual(["run_registered:supervisor", "opened:supervisor", "resolved:mariusz"]);
});
