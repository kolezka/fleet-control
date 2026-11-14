import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";
import { RequestError } from "../domain/requests.ts";

function fixture() {
  const db = new Database(":memory:", { strict: true });
  const requests = new Requests(db, () => new Date("2026-01-01T00:00:00Z"));
  requests.registerRun({ runId: "run", orchestrator: "owner", phase: "review" });
  const request = requests.create({ runId: "run", origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?" });
  const input = { runId: "run", actor: "owner", expectedRevision: 1, phase: "next", phaseStatus: "started", newRevision: true };
  const snapshot = () => ({ runs: db.query("SELECT * FROM runs ORDER BY id").all(), requests: db.query("SELECT * FROM requests ORDER BY id").all(), events: db.query("SELECT * FROM request_events ORDER BY seq").all() });
  const phaseEvents = () => db.query("SELECT actor, detail FROM request_events WHERE kind = 'phase_updated'").all();
  return { db, requests, request, input, snapshot, phaseEvents };
}

test("owner phase update records the owner and stales the old request", () => {
  const f = fixture();
  try {
    const result = f.requests.updatePhase(f.input);
    expect(result.run.phase).toBe("next");
    expect(result.run.revision).toBe(2);
    expect(result.staled).toEqual([f.request.id]);
    expect(f.requests.get(f.request.id).status).toBe("stale");
    expect(f.phaseEvents()).toEqual([{ actor: "owner", detail: "next r2 started" }]);
  } finally { f.db.close(); }
});

test("non-owner phase update leaves all state unchanged", () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    let error: unknown;
    try { f.requests.updatePhase({ ...f.input, actor: "intruder" }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe("forbidden");
    expect(f.snapshot()).toEqual(before);
  } finally { f.db.close(); }
});

test("phase update attributes the event to the actor authorized for the update", () => {
  const f = fixture();
  try {
    let reads = 0;
    const input = { ...f.input, get actor() { return ++reads === 1 ? "owner" : "intruder"; } };
    const result = f.requests.updatePhase(input);
    expect(result.run.phase).toBe("next");
    expect(result.run.revision).toBe(2);
    expect(result.staled).toEqual([f.request.id]);
    expect(f.requests.get(f.request.id).status).toBe("stale");
    expect(f.phaseEvents()).toEqual([{ actor: "owner", detail: "next r2 started" }]);
  } finally { f.db.close(); }
});
