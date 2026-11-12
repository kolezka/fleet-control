import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";

// Characterizes unsafe current behavior, not an intended invariant.
for (const replacement of [false, true]) {
  test(`unsafe allowedResponses behavior: ${replacement ? "toJSON replacement" : "sparse arrays"} stores holes as null`, () => {
    const db = new Database(":memory:", { strict: true });
    try {
      const requests = new Requests(db);
      requests.registerRun({ runId: "run", orchestrator: "owner", phase: "review" });
      const sparse = () => {
        const values = new Array<string>(2);
        values[1] = "present";
        return values;
      };
      const inputArray = () => {
        if (!replacement) return sparse();
        const values = ["original"];
        Object.defineProperty(values, "toJSON", { value: () => sparse() });
        return values;
      };
      const created = requests.create({
        runId: "run", origin: "owner", expectedRevision: 1, kind: "approval", question: "Proceed?",
        evidence: ["proof"], allowedResponses: inputArray(),
      });
      expect(created.evidence).toEqual(["proof"]);
      expect(created.allowedResponses as unknown).toEqual([null, "present"]);
      expect(requests.get(created.id)).toEqual(created);
      expect(db.query("SELECT evidence, allowed_responses FROM requests WHERE id = ?").get(created.id))
        .toEqual({ evidence: '["proof"]', allowed_responses: '[null,"present"]' });
    } finally { db.close(); }
  });
}
