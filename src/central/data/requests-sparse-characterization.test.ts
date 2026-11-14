import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { RequestError } from "../../domain/requests.ts";
import { CentralRequests } from "./requests.ts";

const base = { runId: "run", origin: "owner", expectedRevision: 3, kind: "approval" as const, question: "Proceed?" };

// This fake records SQL calls; it does not model PostgreSQL transactions or locks.
function fixture() {
  const calls: { query: string; values: unknown[] }[] = [];
  let row: Record<string, unknown> | undefined;
  let guards = 0;
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    calls.push({ query, values });
    if (query.includes("FROM central_request_event_lock")) return [{ id: 1 }];
    if (query.includes("FROM central_runs")) return [{ id: "run", orchestrator: "owner", phase: "plan", revision: 3 }];
    if (query.includes("INSERT INTO central_requests (")) {
      const [id, runId, phase, revision, kind, question, proposedAction, scope, evidence, allowedResponses, blocking, origin, createdAt] = values;
      row = { id, runId, phase, revision, kind, question, proposedAction, scope, evidence, allowedResponses, blocking, origin, createdAt, status: "open" };
      return [];
    }
    if (query.includes("INSERT INTO central_request_events")) return [];
    if (query.includes("FROM central_requests")) return row ? [row] : [];
    throw new Error("Unexpected SQL");
  };
  const db = Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) });
  return { store: new CentralRequests(db as unknown as SQL), calls, guard: async () => { guards++; }, guardCount: () => guards };
}

function writes(calls: { query: string }[]) {
  return calls.filter(({ query }) => /^(INSERT|UPDATE|DELETE)\b/.test(query.trim()));
}

for (const field of ["evidence", "allowedResponses"] as const) {
  test("create rejects sparse FIELD after guard and run lookup without writes".replace("FIELD", field), async () => {
    const f = fixture();
    const sparse = ["valid", "valid", "valid"];
    delete sparse[1];
    expect(1 in sparse).toBe(false);
    const error = await f.store.create({ ...base, [field]: sparse }, f.guard).catch((error: unknown) => error);
    expect(f.guardCount()).toBe(1);
    expect(f.calls.some(({ query }) => query.includes("FROM central_runs") && query.includes("FOR UPDATE"))).toBe(true);
    expect(writes(f.calls)).toEqual([]);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe("invalid");
  });
}

for (const field of ["evidence", "allowedResponses"] as const) {
  test("create rejects indexed holes despite clean FIELD iterator".replace("FIELD", field), async () => {
    class CleanIteratorArray extends Array<string> {
      override *[Symbol.iterator](): Generator<string, undefined, unknown> { yield "valid"; yield "valid"; yield "valid"; return undefined; }
    }
    const sparse = new CleanIteratorArray("valid", "valid", "valid");
    delete sparse[1];
    const snapshot = sparse.slice();
    expect(1 in snapshot).toBe(false);
    expect(Array.from(snapshot)).toEqual(["valid", "valid", "valid"]);
    const f = fixture();
    const error = await f.store.create({ ...base, [field]: sparse }, f.guard).catch((error: unknown) => error);
    expect(f.guardCount()).toBe(1);
    expect(f.calls.some(({ query }) => query.includes("FROM central_runs") && query.includes("FOR UPDATE"))).toBe(true);
    expect(writes(f.calls)).toEqual([]);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe("invalid");
  });
}

test("create inserts valid dense arrays unchanged", async () => {
  const f = fixture();
  const result = await f.store.create({ ...base, evidence: ["proof"], allowedResponses: ["approve", "decline"] }, f.guard);
  const insert = f.calls.find(({ query }) => query.includes("INSERT INTO central_requests ("));
  expect(f.guardCount()).toBe(1);
  expect(insert?.values.slice(8, 10)).toEqual(['["proof"]', '["approve","decline"]']);
  expect(result).toMatchObject({ evidence: ["proof"], allowedResponses: ["approve", "decline"], origin: "owner", revision: 3 });
});

for (const [override, kind] of [[{ origin: "intruder" }, "forbidden"], [{ expectedRevision: 4 }, "conflict"]] as const) {
  test("create preserves KIND precedence over sparse arrays".replace("KIND", kind), async () => {
    const f = fixture();
    const error = await f.store.create({ ...base, ...override, evidence: new Array<string>(1), allowedResponses: new Array<string>(1) }, f.guard).catch((error: unknown) => error);
    expect(f.guardCount()).toBe(1);
    expect(f.calls.some(({ query }) => query.includes("FROM central_runs") && query.includes("FOR UPDATE"))).toBe(true);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe(kind);
    expect(writes(f.calls)).toEqual([]);
  });
}

test("create preserves kind validation precedence over sparse arrays", async () => {
  const f = fixture();
  const error = await f.store.create({ ...base, kind: "invalid" as typeof base.kind, evidence: new Array<string>(1) }, f.guard).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).message).toBe("invalid request kind");
  expect(writes(f.calls)).toEqual([]);
});

test("create retains null and empty array defaults", async () => {
  const f = fixture();
  const result = await f.store.create({ ...base, evidence: null, allowedResponses: null } as unknown as Parameters<CentralRequests["create"]>[0], f.guard);
  expect(result).toMatchObject({ evidence: [], allowedResponses: ["approve", "decline"] });
  const empty = fixture();
  const emptyResult = await empty.store.create({ ...base, evidence: [], allowedResponses: [] }, empty.guard);
  expect(emptyResult).toMatchObject({ evidence: [], allowedResponses: ["approve", "decline"] });
});

test("create preserves guard denial precedence over sparse arrays", async () => {
  const f = fixture();
  const denial = new RequestError("forbidden", "access denied");
  let guards = 0;
  const error = await f.store.create({ ...base, evidence: new Array<string>(1), allowedResponses: new Array<string>(1) }, async () => { guards++; throw denial; }).catch((error: unknown) => error);
  expect(guards).toBe(1);
  expect(error).toBe(denial);
  expect(f.calls.some(({ query }) => query.includes("FROM central_runs"))).toBe(false);
  expect(writes(f.calls)).toEqual([]);
});
