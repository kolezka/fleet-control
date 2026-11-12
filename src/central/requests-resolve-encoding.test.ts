import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { RequestError } from "../requests.ts";
import { CentralRequests } from "./requests.ts";

const base = { requestId: "request", response: "approve", actor: "operator", expectedRevision: 1, note: "note" };
const original = { id: "request", runId: "run", phase: "plan", revision: 1, kind: "approval", question: "Question?", proposedAction: "", scope: "", evidence: "[]", allowedResponses: JSON.stringify(["approve"]), blocking: true, origin: "owner", status: "open", response: null, resolvedBy: null, resolutionNote: null, resolvedAt: null, createdAt: "2026-01-01T00:00:00.000Z" };

function fixture(request: Record<string, unknown> = {}, run: Record<string, unknown> = {}) {
  let row: Record<string, unknown> = { ...original, ...request };
  const calls: { query: string; values: unknown[] }[] = [];
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    calls.push({ query, values });
    if (query.includes("FROM central_request_event_lock")) return [{ id: 1 }];
    if (query.includes("FROM central_requests")) return [{ ...row }];
    if (query.includes("FROM central_runs")) return [{ id: "run", orchestrator: "owner", phase: "plan", revision: 1, phaseStatus: "planned", updatedAt: original.createdAt, ...run }];
    if (query.includes("UPDATE central_requests")) {
      row = { ...row, status: "resolved", response: values[0] as string, resolvedBy: values[1] as string, resolutionNote: values[2] as string, resolvedAt: values[3] as string };
      return [];
    }
    if (query.includes("INSERT INTO central_request_events")) return [];
    throw new Error(`Unexpected SQL: ${query}`);
  };
  const db = Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) });
  return { store: new CentralRequests(db as unknown as SQL, () => new Date(original.createdAt)), calls };
}

async function errorOf(operation: Promise<unknown>) {
  try { await operation; } catch (error) { return error; }
  return undefined;
}

function expectNoWrites(calls: { query: string }[]) {
  expect(calls.filter(({ query }) => /^(UPDATE|INSERT|DELETE)\b/.test(query.trim()))).toEqual([]);
}

for (const [name, value] of [["NUL", "a\0b"], ["lone high surrogate", "a\ud800b"], ["lone low surrogate", "a\udc00b"]] as const) {
  for (const field of ["actor", "note", "response"] as const) {
    test(`resolve rejects ${field} with ${name} before any write`, async () => {
      const f = fixture(field === "response" ? { allowedResponses: JSON.stringify([value]) } : {});
      const error = await errorOf(f.store.resolve({ ...base, [field]: value }));
      expectNoWrites(f.calls);
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).kind).toBe("invalid");
    });
  }
}

for (const value of ["a\ufffdb", "a\ud83d\ude00b"]) {
  test(`resolve preserves valid Unicode ${value}`, async () => {
    const f = fixture({ allowedResponses: JSON.stringify([value]) });
    const result = await f.store.resolve({ ...base, actor: value, note: value, response: value });
    expect(result).toMatchObject({ status: "resolved", response: value, resolvedBy: value, resolutionNote: value });
    expect(f.calls.find(({ query }) => query.includes("UPDATE central_requests"))?.values.slice(0, 3)).toEqual([value, value, value]);
    expect(f.calls.find(({ query }) => query.includes("INSERT INTO central_request_events"))?.values.slice(2, 5)).toEqual(["resolved", value, `${value}: ${value}`]);
  });
}

test("resolve preserves stale, non-open and disallowed response precedence", async () => {
  for (const [request, run, input, kind, message] of [
    [{}, {}, { ...base, expectedRevision: 2, note: "bad\0" }, "conflict", "stale revision"],
    [{}, { phase: "other" }, { ...base, note: "bad\0" }, "conflict", "stale revision"],
    [{ status: "withdrawn" }, {}, { ...base, note: "bad\0" }, "conflict", "cannot be answered"],
    [{}, {}, { ...base, response: "disallowed", note: "bad\0" }, "invalid", "response must be one of"],
  ] as const) {
    const f = fixture(request, run);
    const error = await errorOf(f.store.resolve(input));
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe(kind);
    expect((error as Error).message).toContain(message);
    expectNoWrites(f.calls);
  }
});

for (const status of ["resolved", "acknowledged"]) {
  for (const value of ["valid", "bad\0value", "bad\ud800value", "bad\udc00value"]) {
    test(`resolve replays ${status} with ${JSON.stringify(value)}`, async () => {
      const f = fixture({ status, response: value, resolvedBy: value, resolutionNote: value, allowedResponses: JSON.stringify(["different"]) });
      const result = await f.store.resolve({ ...base, response: value, actor: value, note: value });
      expect(result).toMatchObject({ status, response: value, resolvedBy: value, resolutionNote: value });
      expectNoWrites(f.calls);
    });
  }
  test(`resolve checks conflicting ${status} replay before encoding`, async () => {
    const f = fixture({ status, response: "approve", resolvedBy: "operator", resolutionNote: "note" });
    const error = await errorOf(f.store.resolve({ ...base, note: "bad\0note" }));
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe("conflict");
    expect((error as Error).message).toContain("already answered");
    expectNoWrites(f.calls);
  });
}
