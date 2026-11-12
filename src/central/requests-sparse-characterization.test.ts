import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { RequestError } from "../requests.ts";
import { CentralRequests } from "./requests.ts";

const base = { runId: "run", origin: "owner", expectedRevision: 3, kind: "approval" as const, question: "Proceed?" };

function fixture() {
  const inserts: unknown[][] = [];
  let row: Record<string, unknown> | undefined;
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("FROM central_request_event_lock")) return [{ id: 1 }];
    if (query.includes("FROM central_runs")) return [{ id: "run", orchestrator: "owner", phase: "plan", revision: 3 }];
    if (query.includes("INSERT INTO central_requests (")) {
      inserts.push(values);
      const [id, runId, phase, revision, kind, question, proposedAction, scope, evidence, allowedResponses, blocking, origin, createdAt] = values;
      row = { id, runId, phase, revision, kind, question, proposedAction, scope, evidence, allowedResponses, blocking, origin, createdAt, status: "open" };
      return [];
    }
    if (query.includes("INSERT INTO central_request_events")) return [];
    if (query.includes("FROM central_requests")) return row ? [row] : [];
    throw new Error(`Unexpected SQL: ${query}`);
  };
  const db = Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) });
  return { store: new CentralRequests(db as unknown as SQL), inserts };
}

for (const field of ["evidence", "allowedResponses"] as const) {
  test(`create serializes sparse ${field} as null in the INSERT`, async () => {
    const { store, inserts } = fixture();
    const sparse = new Array<string>(1);
    expect(0 in sparse).toBe(false);
    const result = await store.create({ ...base, [field]: sparse });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![field === "evidence" ? 8 : 9]).toBe("[null]");
    expect(result[field] as unknown).toEqual([null]);
    expect(result).toMatchObject({ origin: "owner", revision: 3, phase: "plan" });
  });
}

test("create inserts valid dense arrays unchanged", async () => {
  const { store, inserts } = fixture();
  const result = await store.create({ ...base, evidence: ["proof"], allowedResponses: ["approve", "decline"] });
  expect(inserts).toHaveLength(1);
  expect(inserts[0]!.slice(8, 10)).toEqual(['["proof"]', '["approve","decline"]']);
  expect(result).toMatchObject({ evidence: ["proof"], allowedResponses: ["approve", "decline"], origin: "owner", revision: 3 });
});

for (const [override, kind] of [[{ origin: "intruder" }, "forbidden"], [{ expectedRevision: 4 }, "conflict"]] as const) {
  test(`create rejects ${kind} before inserting sparse arrays`, async () => {
    const { store, inserts } = fixture();
    const error = await store.create({ ...base, ...override, evidence: new Array<string>(1), allowedResponses: new Array<string>(1) }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe(kind);
    expect(inserts).toHaveLength(0);
  });
}
