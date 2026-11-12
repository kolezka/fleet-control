import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { RequestError, Requests } from "./requests.ts";

function fixture() {
  const db = new Database(":memory:", { strict: true });
  const requests = new Requests(db, () => new Date("2026-01-01T00:00:00Z"));
  requests.registerRun({ runId: "run", orchestrator: "supervisor", phase: "review" });
  const request = requests.create({ runId: "run", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Proceed?" });
  const input = { runId: "run", actor: "supervisor", expectedRevision: 1, phase: "next", phaseStatus: "started", newRevision: true };
  const snapshot = () => ({ runs: db.query("SELECT * FROM runs ORDER BY id").all(), requests: db.query("SELECT * FROM requests ORDER BY id").all(), events: db.query("SELECT * FROM request_events ORDER BY seq").all() });
  return { db, requests, request, input, snapshot };
}

function errorKind(fn: () => unknown) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    return (error as RequestError).kind;
  }
  return undefined;
}

for (const field of ["phase", "phaseStatus"] as const) {
  for (const [name, value] of [["lone high surrogate", "x\ud800"], ["lone low surrogate", "x\udc00"], ["reversed pair", "x\udc00\ud800"]] as const) {
    test(`rejects ${name} in ${field} without changing state`, () => {
      const f = fixture();
      try {
        const before = f.snapshot();
        const kind = errorKind(() => f.requests.updatePhase({ ...f.input, [field]: value }));
        expect(f.snapshot()).toEqual(before);
        expect(kind).toBe("invalid");
      } finally { f.db.close(); }
    });
  }
}

test("null phase retains the existing phase for untyped callers", () => {
  const f = fixture();
  try {
    const input = { ...f.input, phase: null, newRevision: false } as unknown as Parameters<Requests["updatePhase"]>[0];
    const result = f.requests.updatePhase(input);
    expect(result.run.phase).toBe("review");
    expect(result.run.revision).toBe(1);
    expect(f.requests.get(f.request.id).status).toBe("open");
  } finally { f.db.close(); }
});

test("accepts supplementary characters and literal replacement characters exactly", () => {
  const f = fixture();
  try {
    const result = f.requests.updatePhase({ ...f.input, phase: "phase 😀 �", phaseStatus: "status 😀 �" });
    expect(result.run.phase).toBe("phase 😀 �");
    expect(result.run.phaseStatus).toBe("status 😀 �");
    expect(result.run.revision).toBe(2);
    expect(result.staled).toEqual([f.request.id]);
    expect(f.requests.get(f.request.id).status).toBe("stale");
    const events = f.db.query("SELECT detail FROM request_events WHERE kind = 'phase_updated'").all();
    expect(events).toEqual([{ detail: "phase 😀 � r2 status 😀 �" }]);
  } finally { f.db.close(); }
});

for (const field of ["phase", "phaseStatus"] as const) {
  for (const [name, override, expected] of [
    ["authorization before validation and conflict", { actor: "worker", expectedRevision: 0 }, "forbidden"],
    ["revision conflict before validation", { expectedRevision: 0 }, "conflict"],
  ] as const) {
    test(`preserves ${name} for malformed ${field}`, () => {
      const f = fixture();
      try {
        const before = f.snapshot();
        const kind = errorKind(() => f.requests.updatePhase({ ...f.input, ...override, [field]: "x\ud800" }));
        expect(f.snapshot()).toEqual(before);
        expect(kind).toBe(expected);
      } finally { f.db.close(); }
    });
  }
}
