import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";
import { RequestError } from "../domain/requests.ts";

function fixture() {
  const db = new Database(":memory:", { strict: true });
  const requests = new Requests(db, () => new Date("2026-01-01T00:00:00Z"));
  const snapshot = () => ({
    runs: db.query("SELECT * FROM runs ORDER BY id").all(),
    events: db.query("SELECT * FROM request_events ORDER BY seq").all(),
  });
  return { db, requests, snapshot };
}

function errorKind(operation: () => unknown) {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    return (error as RequestError).kind;
  }
  return undefined;
}

for (const [name, phase] of [["high surrogate", "phase-\ud800"], ["low surrogate", "phase-\udc00"], ["reversed pair", "phase-\udc00\ud800"]] as const) {
  test(`new run rejects malformed ${name} before any insert`, () => {
    const f = fixture();
    try {
      const before = f.snapshot();
      f.db.run("CREATE TRIGGER reject_run_insert BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'unexpected insert'); END");
      expect(errorKind(() => f.requests.registerRun({ runId: "run", orchestrator: "owner", phase }))).toBe("invalid");
      expect(f.snapshot()).toEqual(before);
    } finally { f.db.close(); }
  });

  test(`replay ignores malformed ${name}, but enforces ownership`, () => {
    const f = fixture();
    try {
      const existing = f.requests.registerRun({ runId: "run", orchestrator: "owner", phase: "plan" });
      const before = f.snapshot();
      expect(f.requests.registerRun({ runId: "run", orchestrator: "owner", phase })).toEqual(existing);
      expect(errorKind(() => f.requests.registerRun({ runId: "run", orchestrator: "other", phase }))).toBe("forbidden");
      expect(f.snapshot()).toEqual(before);
    } finally { f.db.close(); }
  });
}

for (const [name, phase] of [["supplementary character", "phase-😀"], ["replacement character", "phase-\ufffd"]] as const) {
  test(`new run preserves valid ${name} in run and event`, () => {
    const f = fixture();
    try {
      expect(f.requests.registerRun({ runId: "run", orchestrator: "owner", phase }).phase).toBe(phase);
      expect(f.requests.run("run").phase).toBe(phase);
      expect(f.db.query("SELECT detail FROM request_events WHERE kind = 'run_registered'").all()).toEqual([{ detail: `phase ${phase} revision 1` }]);
    } finally { f.db.close(); }
  });
}

test("new run samples phase once for validation, insert and event", () => {
  const f = fixture();
  try {
    let reads = 0;
    const input = { runId: "run", orchestrator: "owner", get phase() { return ++reads === 1 ? "plan" : "changed-\ud800"; } };
    expect(f.requests.registerRun(input).phase).toBe("plan");
    expect(reads).toBe(1);
    expect(f.db.query("SELECT detail FROM request_events WHERE kind = 'run_registered'").all()).toEqual([{ detail: "phase plan revision 1" }]);
  } finally { f.db.close(); }
});
