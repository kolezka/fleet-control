import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Requests } from "./requests.ts";
import { RequestError } from "../domain/requests.ts";

test("creation checks run, owner and revision before reading later fields", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    const requests = new Requests(db);
    requests.registerRun({ runId: "run", orchestrator: "owner", phase: "review" });
    const base = { runId: "run", origin: "owner", expectedRevision: 1, kind: "approval" as const, question: "Question" };
    const cases = [
      { ...base, runId: "missing", get origin(): string { throw new Error("origin read"); } },
      { ...base, origin: "other", get kind(): "approval" { throw new Error("kind read"); } },
      { ...base, expectedRevision: 0, get kind(): "approval" { throw new Error("kind read"); } },
    ];
    for (const [index, input] of cases.entries()) {
      let error: unknown;
      try { requests.create(input); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).kind).toBe((["not_found", "forbidden", "conflict"] as const)[index]!);
    }
    expect(db.query("SELECT count(*) AS count FROM requests").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});
