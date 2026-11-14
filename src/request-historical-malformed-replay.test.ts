import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RequestError, Requests } from "./data/requests";

for (const status of ["resolved", "acknowledged"] as const) {
  for (const malformed of ["actor", "note", "both"] as const) {
    test(`${status}: malformed ${malformed} snapshot replays without changes and mismatches conflict`, () => {
      const db = new Database(":memory:");
      try {
        const requests = new Requests(db);
        requests.registerRun({ runId: "run", orchestrator: "supervisor", phase: "review" });
        const opened = requests.create({ runId: "run", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Proceed?" });
        const input = { requestId: opened.id, actor: "human", response: "approve", expectedRevision: 1, note: "note" };
        requests.resolve(input);
        if (status === "acknowledged") requests.acknowledge({ requestId: opened.id, actor: "supervisor" });
        const originalGet = requests.get.bind(requests);
        const persisted = originalGet(opened.id);
        const events = requests.events();
        const actor = malformed === "note" ? "human" : "human\ud800";
        const note = malformed === "actor" ? "note" : "note\udfff";
        const snapshot = { ...persisted, resolvedBy: actor, resolutionNote: note };
        // This override models a historical JS snapshot, not SQLite storage of malformed UTF-16.
        requests.get = (id) => id === opened.id ? snapshot : originalGet(id);
        const replay = { ...input, actor, note };
        expect(requests.resolve(replay)).toEqual(snapshot);
        for (const mismatch of [
          { ...replay, actor: "other" },
          { ...replay, note: "other" },
          { ...replay, response: "decline" },
          { ...replay, expectedRevision: 2 },
        ]) {
          try {
            requests.resolve(mismatch);
            throw new Error("Expected a conflict");
          } catch (error) {
            expect(error).toBeInstanceOf(RequestError);
            expect((error as RequestError).kind).toBe("conflict");
          }
        }
        expect(snapshot).toEqual({ ...persisted, resolvedBy: actor, resolutionNote: note });
        expect(originalGet(opened.id)).toEqual(persisted);
        expect(requests.events()).toEqual(events);
      } finally {
        db.close();
      }
    });
  }
}
