import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { RequestError } from "../../data/requests.ts";
import { CentralRequests } from "./requests.ts";

const original = { id: "request", runId: "run", phase: "plan", revision: 1, kind: "approval", question: "Question?", proposedAction: "", scope: "", evidence: "[]", allowedResponses: '["approve"]', blocking: true, origin: "owner", status: "open", response: "approve", resolvedBy: "operator", resolutionNote: "", resolvedAt: null, createdAt: "2026-01-01T00:00:00.000Z" };

function fixture(status: string, owner = "owner") {
  let row = { ...original, status };
  const calls: { query: string; values: unknown[] }[] = [];
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    calls.push({ query, values });
    if (query.includes("FROM central_request_event_lock")) return [{ id: 1 }];
    if (query.includes("FROM central_requests")) return [{ ...row }];
    if (query.includes("FROM central_runs")) return [{ id: "run", orchestrator: owner, phase: "plan", revision: 1, phaseStatus: "planned", updatedAt: original.createdAt }];
    if (query.includes("UPDATE central_requests")) { row = { ...row, status: values[0] as string }; return []; }
    if (query.includes("INSERT INTO central_request_events")) return [];
    throw new Error(`Unexpected SQL: ${query}`);
  };
  const db = Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) });
  return { store: new CentralRequests(db as unknown as SQL, () => new Date(original.createdAt)), calls };
}

function noWrites(calls: { query: string }[]) {
  expect(calls.filter(({ query }) => /^(UPDATE|INSERT|DELETE)\b/.test(query.trim()))).toEqual([]);
}

async function errorOf(operation: Promise<unknown>) {
  try { await operation; } catch (error) { return error; }
  return undefined;
}

for (const method of ["acknowledge", "withdraw"] as const) {
  const initial = method === "acknowledge" ? "resolved" : "open";
  for (const [name, actor] of [["NUL", "bad\0actor"], ["high surrogate", "bad\ud800actor"], ["low surrogate", "bad\udc00actor"]] as const) {
    test(`${method} rejects actor with ${name} before writes`, async () => {
      const f = fixture(initial, actor);
      const error = await errorOf(method === "acknowledge" ? f.store.acknowledge({ requestId: "request", actor }) : f.store.withdraw({ requestId: "request", actor, reason: "done" }));
      noWrites(f.calls);
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).kind).toBe("invalid");
    });
  }
  test(`${method} preserves supplementary Unicode`, async () => {
    const actor = "owner 😀", reason = "done 😀";
    const f = fixture(initial, actor);
    const result = await (method === "acknowledge" ? f.store.acknowledge({ requestId: "request", actor }) : f.store.withdraw({ requestId: "request", actor, reason }));
    expect(result.status).toBe(method === "acknowledge" ? "acknowledged" : "withdrawn");
    expect(f.calls.find(({ query }) => query.includes("INSERT INTO central_request_events"))?.values.slice(2, 5)).toEqual([result.status, actor, method === "acknowledge" ? 'read answer "approve"' : reason]);
  });
  test(`${method} guard precedes encoding validation`, async () => {
    const actor = "bad\ud800actor", f = fixture(initial, actor);
    const denied = new Error("guard denied");
    const guard = async () => { throw denied; };
    const error = await errorOf(method === "acknowledge" ? f.store.acknowledge({ requestId: "request", actor }, guard) : f.store.withdraw({ requestId: "request", actor, reason: "bad\udc00reason" }, guard));
    expect(error).toBe(denied);
    expect(f.calls).toEqual([]);
  });
  test(`${method} owner check precedes encoding validation`, async () => {
    const f = fixture(initial);
    const actor = "bad\ud800actor";
    const error = await errorOf(method === "acknowledge" ? f.store.acknowledge({ requestId: "request", actor }) : f.store.withdraw({ requestId: "request", actor, reason: "bad\udc00reason" }));
    expect((error as RequestError).kind).toBe("forbidden");
    noWrites(f.calls);
  });
  test(`${method} status check precedes encoding validation`, async () => {
    const actor = "bad\ud800actor", f = fixture("stale", actor);
    const error = await errorOf(method === "acknowledge" ? f.store.acknowledge({ requestId: "request", actor }) : f.store.withdraw({ requestId: "request", actor, reason: "bad\udc00reason" }));
    expect((error as RequestError).kind).toBe("conflict");
    noWrites(f.calls);
  });
}

for (const [name, reason] of [["NUL", "bad\0reason"], ["high surrogate", "bad\ud800reason"], ["low surrogate", "bad\udc00reason"]] as const) {
  test(`withdraw rejects reason with ${name} before writes`, async () => {
    const f = fixture("open");
    const error = await errorOf(f.store.withdraw({ requestId: "request", actor: "owner", reason }));
    noWrites(f.calls);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe("invalid");
  });
}

test("withdraw owner and status checks precede reason encoding validation", async () => {
  const other = fixture("open");
  expect((await errorOf(other.store.withdraw({ requestId: "request", actor: "intruder", reason: "bad\0reason" })) as RequestError).kind).toBe("forbidden");
  const stale = fixture("resolved");
  expect((await errorOf(stale.store.withdraw({ requestId: "request", actor: "owner", reason: "bad\ud800reason" })) as RequestError).kind).toBe("conflict");
  noWrites(other.calls);
  noWrites(stale.calls);
});

test("withdraw guard precedes reason encoding validation", async () => {
  const f = fixture("open");
  const denied = new Error("guard denied");
  expect(await errorOf(f.store.withdraw({ requestId: "request", actor: "owner", reason: "bad\0reason" }, async () => { throw denied; }))).toBe(denied);
  expect(f.calls).toEqual([]);
});

test("acknowledged replay returns before actor encoding validation for the exact owner", async () => {
  for (const actor of ["owner", "bad\0actor", "bad\ud800actor", "bad\udc00actor"]) {
    const f = fixture("acknowledged", actor);
    expect((await f.store.acknowledge({ requestId: "request", actor })).status).toBe("acknowledged");
    noWrites(f.calls);
  }
});

test("acknowledged replay still requires the owner and guard", async () => {
  const f = fixture("acknowledged", "bad\ud800owner");
  const denied = new Error("guard denied");
  expect(await errorOf(f.store.acknowledge({ requestId: "request", actor: "bad\ud800owner" }, async () => { throw denied; }))).toBe(denied);
  const error = await errorOf(f.store.acknowledge({ requestId: "request", actor: "other" }));
  expect((error as RequestError).kind).toBe("forbidden");
  noWrites(f.calls);
});
