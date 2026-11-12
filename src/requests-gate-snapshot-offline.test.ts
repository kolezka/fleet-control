import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";

test("gate never combines an old phase with a later approval", () => {
  const uri = `file:gate-snapshot-${crypto.randomUUID()}?mode=memory&cache=shared`;
  const readerDb = new Database(uri, { strict: true });
  let writerDb: Database | undefined;
  try {
    writerDb = new Database(uri, { strict: true });
    const reader = new Requests(readerDb);
    const writer = new Requests(writerDb);
    reader.registerRun({ runId: "run", orchestrator: "supervisor", phase: "review" });
    const request = reader.create({ runId: "run", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    expect(writer.run("run").revision).toBe(1);
    expect(writer.get(request.id).status).toBe("open");

    const run = reader.run.bind(reader);
    let intercepted = false;
    let committed = false;
    reader.run = (id) => {
      const result = run(id);
      if (!intercepted) {
        intercepted = true;
        try {
          writerDb!.transaction(() => {
            writer.resolve({ requestId: request.id, response: "approve", actor: "operator", expectedRevision: 1 });
            writer.updatePhase({ runId: "run", actor: "supervisor", expectedRevision: 1, phase: "next", phaseStatus: "planned", newRevision: true });
          })();
          committed = true;
        } catch (error) {
          if (!(error instanceof Error) || !/database (?:table )?is locked/i.test(error.message)) throw error;
        }
      }
      return result;
    };

    const result = reader.gate("run", "review", 1);
    expect(intercepted).toBe(true);
    if (committed) {
      expect(writer.run("run").phase).toBe("next");
      expect(writer.run("run").revision).toBe(2);
      expect(writer.get(request.id).status).toBe("resolved");
      expect(writer.get(request.id).response).toBe("approve");
    } else {
      expect(writer.run("run").revision).toBe(1);
      expect(writer.get(request.id).status).toBe("open");
    }
    expect(result.approved).toBe(false);
  } finally {
    try { writerDb?.close(); } finally { readerDb.close(); }
  }
});

test("gate failure rolls back its savepoint without aborting the outer transaction", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    const requests = new Requests(db);
    requests.registerRun({ runId: "run", orchestrator: "supervisor", phase: "review" });
    const originalList = requests.list.bind(requests);
    const failure = new Error("list failed");
    db.transaction(() => {
      requests.list = () => { throw failure; };
      expect(() => requests.gate("run", "review", 1)).toThrow(failure);
      requests.list = originalList;
      expect(requests.gate("run", "review", 1).approved).toBe(false);
      requests.updatePhase({ runId: "run", actor: "supervisor", expectedRevision: 1, phase: "next", phaseStatus: "planned", newRevision: true });
    })();
    expect(requests.run("run").revision).toBe(2);
  } finally {
    db.close();
  }
});

test("gate inside an outer transaction can see uncommitted approval", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    const requests = new Requests(db);
    requests.registerRun({ runId: "run", orchestrator: "supervisor", phase: "review" });
    const request = requests.create({ runId: "run", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Proceed?" });
    const rollback = new Error("rollback outer transaction");
    expect(() => db.transaction(() => {
      requests.resolve({ requestId: request.id, response: "approve", actor: "operator", expectedRevision: 1 });
      expect(requests.gate("run", "review", 1).approved).toBe(true);
      throw rollback;
    })()).toThrow(rollback);
    expect(requests.get(request.id).status).toBe("open");
    expect(requests.gate("run", "review", 1).approved).toBe(false);
  } finally {
    db.close();
  }
});
