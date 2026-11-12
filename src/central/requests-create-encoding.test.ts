import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { RequestError } from "../requests.ts";
import { CentralRequests } from "./requests.ts";

const base = { runId: "run", origin: "owner", expectedRevision: 1, kind: "approval" as const, question: "Question?" };

function fixture(owner = "owner") {
  const calls: { query: string; values: unknown[] }[] = [];
  let row: Record<string, unknown> | undefined;
  let guards = 0;
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    calls.push({ query, values });
    if (query.includes("FROM central_request_event_lock")) return [];
    if (query.includes("FROM central_runs")) return [{ id: "run", orchestrator: owner, phase: "plan", revision: 1, phaseStatus: "planned", updatedAt: "2026-01-01T00:00:00.000Z" }];
    if (query.includes("INSERT INTO central_requests (")) {
      const [id, runId, phase, revision, kind, question, proposedAction, scope, evidence, allowedResponses, blocking, origin, createdAt] = values;
      row = { id, runId, phase, revision, kind, question, proposedAction, scope, evidence, allowedResponses, blocking, origin, status: "open", createdAt };
      return [];
    }
    if (query.includes("INSERT INTO central_request_events")) return [];
    if (query.includes("FROM central_requests")) return row ? [row] : [];
    throw new Error(`Unexpected SQL: ${query}`);
  };
  const db = Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) });
  return { store: new CentralRequests(db as unknown as SQL, () => new Date("2026-01-01T00:00:00.000Z")), calls, guard: async () => { guards++; }, guardCount: () => guards };
}

async function errorOf(operation: Promise<unknown>) {
  try { await operation; } catch (error) { return error; }
  return undefined;
}

for (const [name, invalid] of [["NUL", "a\0b"], ["lone high surrogate", "a\ud800b"], ["lone low surrogate", "a\udc00b"]] as const) {
  for (const field of ["origin", "question", "proposedAction", "scope", "evidence", "allowedResponses"] as const) {
    test(`create rejects ${field} with ${name} after lookup and before insertion`, async () => {
      const f = fixture(field === "origin" ? invalid : "owner");
      const value = field === "evidence" || field === "allowedResponses" ? ["valid", invalid] : invalid;
      const error = await errorOf(f.store.create({ ...base, [field]: value }, f.guard));
      expect(f.guardCount()).toBe(1);
      expect(f.calls.some(({ query }) => query.includes("FROM central_runs") && query.includes("FOR UPDATE"))).toBe(true);
      expect(f.calls.filter(({ query }) => /^(INSERT|UPDATE|DELETE)\b/.test(query.trim()))).toEqual([]);
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).kind).toBe("invalid");
    });
  }
}

test("create checks ownership and revision before payload encoding", async () => {
  for (const [input, kind] of [[{ ...base, origin: "intruder", question: "bad\0question" }, "forbidden"], [{ ...base, expectedRevision: 2, question: "bad\0question" }, "conflict"]] as const) {
    const f = fixture();
    const error = await errorOf(f.store.create(input, f.guard));
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe(kind);
    expect(f.guardCount()).toBe(1);
    expect(f.calls.some(({ query }) => query.includes("FROM central_runs") && query.includes("FOR UPDATE"))).toBe(true);
    expect(f.calls.some(({ query }) => /^(INSERT|UPDATE|DELETE)\b/.test(query.trim()))).toBe(false);
  }
});

for (const [name, value] of [["replacement character", "a\ufffdb"], ["supplementary character", "a\ud83d\ude00b"]] as const) {
  test(`create preserves ${name} in all text fields`, async () => {
    const f = fixture(value);
    const result = await f.store.create({ ...base, origin: value, question: value, proposedAction: value, scope: value, evidence: [value], allowedResponses: [value], blocking: false }, f.guard);
    expect(result).toMatchObject({ origin: value, question: value, proposedAction: value, scope: value, evidence: [value], allowedResponses: [value], blocking: false });
    const insert = f.calls.find(({ query }) => query.includes("INSERT INTO central_requests ("));
    expect(insert?.values.slice(5, 12)).toEqual([value, value, value, JSON.stringify([value]), JSON.stringify([value]), false, value]);
    expect(f.guardCount()).toBe(1);
  });
}

for (const [kind, allowedResponses] of [["approval", ["approve", "decline"]], ["clarification", ["answer"]]] as const) {
  test(`create retains defaults for ${kind}`, async () => {
    const f = fixture();
    const result = await f.store.create({ ...base, kind, allowedResponses: [] }, f.guard);
    expect(result).toMatchObject({ proposedAction: "", scope: "", evidence: [], allowedResponses, blocking: true });
    const insert = f.calls.find(({ query }) => query.includes("INSERT INTO central_requests ("));
    expect(insert?.values.slice(6, 11)).toEqual(["", "", "[]", JSON.stringify(allowedResponses), true]);
  });
}
