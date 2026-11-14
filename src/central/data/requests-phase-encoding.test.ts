import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { RequestError } from "../../data/requests.ts";
import { CentralRequests } from "./requests.ts";

const original = { id: "run", orchestrator: "owner", phase: "plan", revision: 1, phaseStatus: "planned", updatedAt: "2026-01-01T00:00:00.000Z" };

function fixture(owner = "owner") {
  let run = { ...original, orchestrator: owner };
  const calls: { query: string; values: unknown[] }[] = [];
  let guards = 0;
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    calls.push({ query, values });
    if (query.includes("FROM central_request_event_lock")) return [{ id: 1 }];
    if (query.includes("FROM central_runs")) return [{ ...run }];
    if (query.includes("UPDATE central_runs")) {
      run = { ...run, phase: values[0] as string, revision: values[1] as number, phaseStatus: values[2] as string, updatedAt: values[3] as string };
      return [];
    }
    if (query.includes("INSERT INTO central_request_events")) return [];
    if (query.includes("UPDATE central_requests")) return [{ id: "request", revision: 1 }];
    throw new Error(`Unexpected SQL: ${query}`);
  };
  const db = Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) });
  return { store: new CentralRequests(db as unknown as SQL, () => new Date(original.updatedAt)), calls, guard: async () => { guards++; }, guardCount: () => guards };
}

async function errorOf(operation: Promise<unknown>) {
  try { await operation; } catch (error) { return error; }
  return undefined;
}

const base = { runId: "run", actor: "owner", expectedRevision: 1, phase: "build", phaseStatus: "running", newRevision: false };

for (const [name, invalid] of [["NUL", "a\0b"], ["lone high surrogate", "a\ud800b"], ["lone low surrogate", "a\udc00b"]] as const) {
  for (const field of ["actor", "phase", "phaseStatus"] as const) {
    test(`updatePhase rejects ${field} with ${name} before any write`, async () => {
      const f = fixture(field === "actor" ? invalid : "owner");
      const error = await errorOf(f.store.updatePhase({ ...base, [field]: invalid }, f.guard));
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).kind).toBe("invalid");
      expect(f.calls.filter(({ query }) => /^(UPDATE|INSERT|DELETE)\b/.test(query.trim()))).toEqual([]);
    });
  }
}

for (const [name, value] of [["replacement character", "a\ufffdb"], ["supplementary character", "a\ud83d\ude00b"]] as const) {
  test(`updatePhase preserves ${name} in actor, phase and status`, async () => {
    const f = fixture(value);
    const result = await f.store.updatePhase({ ...base, actor: value, phase: value, phaseStatus: value }, f.guard);
    expect(result).toEqual({ run: { ...original, orchestrator: value, phase: value, phaseStatus: value, revision: 2 }, staled: ["request"] });
    expect(f.guardCount()).toBe(1);
    expect(f.calls.find(({ query }) => query.includes("UPDATE central_runs"))?.values.slice(0, 3)).toEqual([value, 2, value]);
    expect(f.calls.find(({ query }) => query.includes("INSERT INTO central_request_events"))?.values.slice(0, 5)).toEqual([null, "run", "phase_updated", value, `${value} r2 ${value}`]);
  });
}

test("updatePhase rejects a non-owner without writing", async () => {
  const f = fixture();
  const error = await errorOf(f.store.updatePhase({ ...base, actor: "intruder" }, f.guard));
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).kind).toBe("forbidden");
  expect((error as Error).message).toBe("access denied");
  expect(f.guardCount()).toBe(1);
  expect(f.calls.some(({ query }) => /^(UPDATE|INSERT|DELETE)\b/.test(query.trim()))).toBe(false);
});

test("updatePhase rejects a stale revision without writing", async () => {
  const f = fixture();
  const error = await errorOf(f.store.updatePhase({ ...base, expectedRevision: 2 }, f.guard));
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).kind).toBe("conflict");
  expect(f.guardCount()).toBe(1);
  expect(f.calls.some(({ query }) => /^(UPDATE|INSERT|DELETE)\b/.test(query.trim()))).toBe(false);
});
