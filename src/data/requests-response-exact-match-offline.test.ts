import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";
import { RequestError } from "../domain/requests.ts";

// SQLite stores a lone surrogate as U+FFFD, so the two spellings must never answer for each other.
const malformed = "x\ud800";
const replacement = "x\ufffd";

function fixture(storedOptions: string[]) {
  const db = new Database(":memory:", { strict: true });
  const requests = new Requests(db);
  requests.registerRun({ runId: "run", orchestrator: "supervisor", phase: "review" });
  const request = requests.create({ runId: "run", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Proceed?", allowedResponses: ["approve"] });
  // create refuses malformed options, so a row from before that check is written directly.
  db.query("UPDATE requests SET allowed_responses = ? WHERE id = ?").run(JSON.stringify(storedOptions), request.id);
  const snapshot = () => [db.query("SELECT * FROM requests").all(), db.query("SELECT * FROM request_events ORDER BY seq").all()];
  return { db, requests, id: request.id, snapshot };
}

const cases = [
  ["a replacement character does not answer a malformed option", malformed, replacement],
  ["a malformed response does not answer a replacement-character option", replacement, malformed],
] as const;

for (const [name, option, response] of cases) {
  test(name, () => {
    const f = fixture([option]);
    try {
      expect(f.requests.get(f.id).allowedResponses).toEqual([option]);
      const before = f.snapshot();
      let error: unknown;
      try { f.requests.resolve({ requestId: f.id, response, actor: "alice", expectedRevision: 1 }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).kind).toBe("invalid");
      expect(f.snapshot()).toEqual(before);
    } finally { f.db.close(); }
  });
}
