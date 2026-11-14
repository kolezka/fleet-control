import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralRequests } from "./requests.ts";

// This fake models transaction rollback, not PostgreSQL locking or rollback.
function registerFixture(lockExists: boolean) {
  const at = "2026-01-01T00:00:00.000Z";
  let committed: { guardWrites: number; run: null | { id: string; orchestrator: string; phase: string; revision: number; phaseStatus: string; updatedAt: string }; events: number } = { guardWrites: 0, run: null, events: 0 };
  const calls: string[] = [];
  const root = async (parts: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
    throw new Error(`Root connection denied SQL: ${parts.join("?")}`);
  };
  const db = Object.assign(root, {
    begin: async (fn: (tx: typeof root) => Promise<unknown>) => {
      const staged = structuredClone(committed);
      const tx = async (parts: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
        const query = parts.join("?").replace(/\s+/g, " ").trim();
        if (query === "UPDATE fake_guard SET writes = writes + 1") { calls.push("guard write"); staged.guardWrites++; return []; }
        if (query === "SELECT id FROM central_request_event_lock WHERE id = 1 FOR UPDATE") { calls.push("event lock"); return lockExists ? [{ id: 1 }] : []; }
        if (query.includes("FROM central_runs")) { calls.push("run lookup"); return staged.run ? [staged.run] : []; }
        if (query.startsWith("INSERT INTO central_runs")) {
          calls.push("run insert");
          staged.run = { id: values[0] as string, orchestrator: values[1] as string, phase: values[2] as string, revision: 1, phaseStatus: "planned", updatedAt: values[3] as string };
          return [];
        }
        if (query.startsWith("INSERT INTO central_request_events")) { calls.push("event insert"); staged.events++; return []; }
        throw new Error(`Unexpected SQL: ${query}`);
      };
      const result = await fn(tx);
      committed = staged;
      return result;
    },
  });
  return { store: new CentralRequests(db as unknown as SQL, () => new Date(at)), calls, snapshot: () => structuredClone(committed) };
}

test("missing event lock rolls back guard write before registerRun executes", async () => {
  const f = registerFixture(false);
  const before = f.snapshot();
  await expect(f.store.registerRun({ runId: "run", orchestrator: "owner", phase: "plan" }, async (tx) => {
    await tx`UPDATE fake_guard SET writes = writes + 1`;
  })).rejects.toThrow("central request event lock row missing");
  expect(f.calls).toEqual(["guard write", "event lock"]);
  expect(f.snapshot()).toEqual(before);
});

test("present event lock commits guard write and registerRun", async () => {
  const f = registerFixture(true);
  const run = await f.store.registerRun({ runId: "run", orchestrator: "owner", phase: "plan" }, async (tx) => {
    await tx`UPDATE fake_guard SET writes = writes + 1`;
  });
  expect(f.calls).toEqual(["guard write", "event lock", "run lookup", "run insert", "event insert", "run lookup"]);
  expect(run).toEqual({ id: "run", orchestrator: "owner", phase: "plan", revision: 1, phaseStatus: "planned", updatedAt: "2026-01-01T00:00:00.000Z" });
  expect(f.snapshot()).toEqual({ guardWrites: 1, run, events: 1 });
});

test("guard failure rolls back its write before event lock or registration", async () => {
  const f = registerFixture(true);
  const before = f.snapshot();
  const sentinel = new Error("guard sentinel");
  let caught: unknown;
  try {
    await f.store.registerRun({ runId: "run", orchestrator: "owner", phase: "plan" }, async (tx) => {
      await tx`UPDATE fake_guard SET writes = writes + 1`;
      throw sentinel;
    });
  } catch (error) { caught = error; }
  expect(caught).toBe(sentinel);
  expect(f.calls).toEqual(["guard write"]);
  expect(f.snapshot()).toEqual(before);
});

test("request transactions require the singleton lock after the guard and before the callback", async () => {
  for (const exists of [false, true]) {
    const calls: string[] = [];
    const sql = async (parts: TemplateStringsArray) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      calls.push(query);
      if (query === "SELECT id FROM central_request_event_lock WHERE id = 1 FOR UPDATE") return exists ? [{ id: 1 }] : [];
      if (query.includes("FROM central_runs")) return [{ id: "run", orchestrator: "owner", phase: "plan", revision: 1 }];
      if (query.includes("FROM central_requests")) return [];
      throw new Error(`Unexpected SQL: ${query}`);
    };
    const db = Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) });
    const store = new CentralRequests(db as unknown as SQL);
    const operation = store.gateScoped("run", "plan", 1, "owner", async () => { calls.push("guard"); });
    if (exists) {
      expect(await operation).toEqual({ approved: false, reason: "no approval request for this revision", requestId: null });
      expect(calls).toHaveLength(4);
      expect(calls[2]).toContain("FROM central_runs");
      expect(calls[3]).toContain("FROM central_requests");
    } else {
      await expect(operation).rejects.toThrow("central request event lock row missing");
      expect(calls).toHaveLength(2);
    }
    expect(calls.slice(0, 2)).toEqual(["guard", "SELECT id FROM central_request_event_lock WHERE id = 1 FOR UPDATE"]);
  }
});
