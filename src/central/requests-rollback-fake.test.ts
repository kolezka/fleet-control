import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralRequests } from "./requests.ts";

// This fake checks transaction wiring, not PostgreSQL rollback behavior.
const at = "2026-01-01T00:00:00.000Z";
const row = { id: "request", runId: "run", phase: "plan", revision: 1, kind: "approval", question: "Question?", proposedAction: "", scope: "", evidence: "[]", allowedResponses: '["approve"]', blocking: true, origin: "owner", status: "open", response: null, resolvedBy: null, resolutionNote: null, resolvedAt: null, createdAt: at };
const event = { requestId: "request", runId: "run", kind: "opened", actor: "owner", detail: "existing", at };

function fixture(failure?: Error) {
  let committed = { row: { ...row }, events: [event] };
  const stagedStatuses: string[] = [];
  let insertAttempts = 0;
  const root = async (parts: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
    throw new Error(`Root connection denied SQL: ${parts.join("?")}`);
  };
  const db = Object.assign(root, {
    begin: async (fn: (tx: typeof root) => Promise<unknown>) => {
      const staged = structuredClone(committed);
      const tx = async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const query = parts.join("?");
        if (query.includes("FROM central_request_event_lock")) return [];
        if (query.includes("FROM central_requests")) return values[0] === staged.row.id ? [{ ...staged.row }] : [];
        if (query.includes("FROM central_runs")) return values[0] === "run" ? [{ id: "run", orchestrator: "owner", phase: "plan", revision: 1, phaseStatus: "planned", updatedAt: at }] : [];
        if (query.includes("UPDATE central_requests")) {
          if (values[1] !== staged.row.id) throw new Error("Unexpected request ID");
          staged.row.status = values[0] as string;
          stagedStatuses.push(staged.row.status);
          return [];
        }
        if (query.includes("INSERT INTO central_request_events")) {
          insertAttempts++;
          if (failure) throw failure;
          const [requestId, runId, kind, actor, detail, at] = values as [string, string, string, string, string, string];
          staged.events.push({ requestId, runId, kind, actor, detail, at });
          return [];
        }
        throw new Error(`Unexpected SQL: ${query}`);
      };
      const result = await fn(tx);
      committed = staged;
      return result;
    },
  });
  return { db, store: new CentralRequests(db as unknown as SQL, () => new Date(at)), snapshot: () => structuredClone(committed), stagedStatuses, insertAttempts: () => insertAttempts };
}

const input = { requestId: "request", actor: "owner", reason: "no longer needed" };

test("withdraw rolls back its staged update when event insertion fails", async () => {
  const sentinel = new Error("event insert sentinel");
  const f = fixture(sentinel), before = f.snapshot();
  let caught: unknown;
  try { await f.store.withdraw(input); } catch (error) { caught = error; }
  expect(caught).toBe(sentinel);
  expect(f.stagedStatuses).toEqual(["withdrawn"]);
  expect(f.insertAttempts()).toBe(1);
  expect(f.snapshot()).toEqual(before);
});

test("withdraw commits the update and event together", async () => {
  const f = fixture();
  const result = await f.store.withdraw(input);
  expect(result.status).toBe("withdrawn");
  expect(f.stagedStatuses).toEqual(["withdrawn"]);
  expect(f.insertAttempts()).toBe(1);
  expect(f.snapshot()).toEqual({ row: { ...row, status: "withdrawn" }, events: [event, { requestId: "request", runId: "run", kind: "withdrawn", actor: "owner", detail: input.reason, at }] });
});

test("fake root connection denies writes", async () => {
  const f = fixture();
  await expect(f.db`UPDATE central_requests SET status = ${"withdrawn"}`).rejects.toThrow("Root connection denied SQL");
});
