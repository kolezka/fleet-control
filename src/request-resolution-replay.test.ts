import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Requests } from "./data/requests.ts";
import { RequestError } from "./domain/requests.ts";

function fixture(status: "resolved" | "acknowledged", resolutionNote: string | null = "original note") {
  const row = {
    id: "req-1", runId: "run-1", phase: "review", revision: 3, kind: "approval" as const,
    question: "Proceed?", proposedAction: "", scope: "", evidence: "[]",
    allowedResponses: '["approve","decline"]', blocking: 1, origin: "supervisor",
    status, response: "approve", resolvedBy: "alice", resolutionNote,
    resolvedAt: "2026-01-01T00:00:00.000Z", createdAt: "2025-12-31T00:00:00.000Z",
  };
  const writes: string[] = [];
  const db = {
    run(sql: string) {
      if (!sql.startsWith("CREATE TABLE IF NOT EXISTS") && !sql.startsWith("CREATE INDEX IF NOT EXISTS")) throw new Error(`Unexpected setup SQL: ${sql}`);
    },
    transaction<T>(fn: () => T) { return fn; },
    query(sql: string) {
      return {
        get(id: string) {
          if (!sql.startsWith("SELECT id, run_id AS runId") || id !== row.id) throw new Error(`Unexpected read: ${sql}`);
          return { ...row };
        },
        run() { writes.push(sql); throw new Error(`Unexpected write: ${sql}`); },
      };
    },
  };
  const requests = new Requests(db as unknown as Database);
  const input = { requestId: row.id, response: "approve", actor: "alice", expectedRevision: 3, note: "original note" };
  return { requests, input, writes, row };
}

function expectConflict(fn: () => unknown) {
  try {
    fn();
    throw new Error("Expected a conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe("conflict");
  }
}

for (const status of ["resolved", "acknowledged"] as const) {
  test(`${status}: exact replay returns the original without writes`, () => {
    const { requests, input, writes, row } = fixture(status);
    expect(requests.resolve(input)).toEqual({ ...row, evidence: [], allowedResponses: ["approve", "decline"], blocking: true });
    expect(writes).toEqual([]);
  });

  test(`${status}: replay with another revision conflicts without writes`, () => {
    const { requests, input, writes } = fixture(status);
    expectConflict(() => requests.resolve({ ...input, expectedRevision: 4 }));
    expect(writes).toEqual([]);
  });

  test(`${status}: replay with another note conflicts without writes`, () => {
    const { requests, input, writes } = fixture(status);
    expectConflict(() => requests.resolve({ ...input, note: "different note" }));
    expect(writes).toEqual([]);
  });

  test(`${status}: a different actor conflicts without writes`, () => {
    const { requests, input, writes } = fixture(status);
    expectConflict(() => requests.resolve({ ...input, actor: "bob" }));
    expect(writes).toEqual([]);
  });

  test(`${status}: undefined and empty notes are equivalent`, () => {
    for (const stored of ["", null]) {
      for (const note of [undefined, ""]) {
        const { requests, input, writes } = fixture(status, stored);
        expect(requests.resolve({ ...input, note }).resolutionNote).toBe(stored);
        expect(writes).toEqual([]);
      }
    }
  });
}
