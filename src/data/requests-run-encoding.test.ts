import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";
import { RequestError } from "../domain/requests.ts";

for (const [name, alias] of [["high surrogate", "run-\ud800"], ["low surrogate", "run-\udc00"]] as const) {
  test(`malformed ${name} cannot register, look up or mutate a replacement-character run`, () => {
    const db = new Database(":memory:", { strict: true });
    try {
      const requests = new Requests(db);
      const id = "run-\ufffd";
      requests.registerRun({ runId: id, orchestrator: "owner", phase: "plan" });
      const request = requests.create({ runId: id, origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?" });
      const before = { runs: requests.runs(), requests: requests.list(), events: requests.events() };
      const operations = [
        () => requests.registerRun({ runId: alias, orchestrator: "owner", phase: "plan" }),
        () => requests.run(alias),
        () => requests.list({ runId: alias }),
        () => requests.gate(alias, "plan", 1),
        () => requests.updatePhase({ runId: alias, actor: "owner", expectedRevision: 1, phaseStatus: "changed", newRevision: true }),
        () => requests.create({ runId: alias, origin: "owner", expectedRevision: 1, kind: "approval", question: "Unexpected?" }),
      ];
      for (const operation of operations) {
        try {
          operation();
          throw new Error("expected invalid runId");
        } catch (error) {
          expect(error).toBeInstanceOf(RequestError);
          expect((error as RequestError).kind).toBe("invalid");
        }
        expect({ runs: requests.runs(), requests: requests.list(), events: requests.events() }).toEqual(before);
      }
      expect(requests.get(request.id).status).toBe("open");
      expect(requests.run(id).id).toBe(id);
    } finally {
      db.close();
    }
  });
}

for (const malformed of ["owner-\ud800", "owner-\udc00"]) {
  test("new run rejects malformed orchestrator without changing state", () => {
    const db = new Database(":memory:", { strict: true });
    try {
      const requests = new Requests(db);
      const before = { runs: requests.runs(), events: requests.events() };
      expect(() => requests.registerRun({ runId: "new", orchestrator: malformed, phase: "plan" })).toThrow(RequestError);
      try {
        requests.registerRun({ runId: "new", orchestrator: malformed, phase: "plan" });
      } catch (error) {
        expect((error as RequestError).kind).toBe("invalid");
      }
      expect({ runs: requests.runs(), events: requests.events() }).toEqual(before);
    } finally {
      db.close();
    }
  });
}

test("existing run replay retains ownership and ignores phase", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    const requests = new Requests(db);
    const existing = requests.registerRun({ runId: "run", orchestrator: "owner-\ufffd", phase: "plan" });
    const before = { runs: requests.runs(), events: requests.events() };
    expect(requests.registerRun({ runId: "run", orchestrator: "owner-\ufffd", phase: "\ud800" })).toEqual(existing);
    try {
      requests.registerRun({ runId: "run", orchestrator: "owner-\ud800", phase: "" });
      throw new Error("expected forbidden");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).kind).toBe("forbidden");
    }
    expect({ runs: requests.runs(), events: requests.events() }).toEqual(before);
  } finally {
    db.close();
  }
});

test("list binds the same run ID that it validates", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    const requests = new Requests(db);
    requests.registerRun({ runId: "run-\ufffd", orchestrator: "owner", phase: "plan" });
    requests.create({ runId: "run-\ufffd", origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    const before = { runs: requests.runs(), requests: requests.list(), events: requests.events() };
    let reads = 0;
    const filter = { get runId() { return ++reads <= 2 ? "safe" : "run-\ud800"; } };
    expect(requests.list(filter)).toEqual([]);
    expect(reads).toBe(1);
    expect({ runs: requests.runs(), requests: requests.list(), events: requests.events() }).toEqual(before);
  } finally {
    db.close();
  }
});

test("well-formed supplementary run IDs register and work normally", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    const requests = new Requests(db);
    const id = "run-\ud83d\ude80";
    expect(requests.registerRun({ runId: id, orchestrator: "owner", phase: "plan" }).id).toBe(id);
    expect(requests.run(id).id).toBe(id);
    expect(requests.updatePhase({ runId: id, actor: "owner", expectedRevision: 1, phaseStatus: "ready", newRevision: false }).run.phaseStatus).toBe("ready");
  } finally {
    db.close();
  }
});
