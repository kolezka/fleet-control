import { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralRequests } from "./requests.ts";

type Row = {
  id: string;
  runId: string;
  phase: string;
  revision: number;
  kind: string;
  status: string;
  response: string | null;
  resolvedBy: string | null;
  createdAt: string;
};

const custom: Row = { id: "custom", runId: "run", phase: "plan", revision: 1, kind: "approval", status: "resolved", response: "revise", resolvedBy: "human", createdAt: "2026-01-01" };
const approve: Row = { ...custom, id: "approve", response: "approve", createdAt: "2026-01-02" };

function fixture(rows: Row[]) {
  let gateQuery = "";
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("FROM central_runs")) return Promise.resolve([{ id: "run", phase: "plan", revision: 1 }]);
    if (query.includes("FROM central_requests")) {
      gateQuery = query;
      const matches = rows.filter((row) => row.runId === values[0] && row.phase === values[1] && row.revision === values[2] && row.kind === "approval" && (row.response === "decline" || row.status === "open" || (["resolved", "acknowledged"].includes(row.status) && row.response === "approve")));
      const priority = (row: Row) => row.response === "decline" ? 0 : row.status === "open" ? 1 : 2;
      matches.sort((a, b) => priority(a) - priority(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return Promise.resolve(matches.slice(0, 1));
    }
    if (query.includes("central_request_event_lock")) return Promise.resolve([{ id: 1 }]);
    throw new Error(`Unexpected SQL: ${query}`);
  }) as unknown as SQL;
  db.begin = (async (fn: (tx: SQL) => Promise<unknown>) => fn(db)) as typeof db.begin;
  return { store: new CentralRequests(db), query: () => gateQuery };
}

for (const scenario of [
  { name: "resolved approve and resolved custom response", rows: [custom, approve], result: { approved: true, reason: "approved by human", requestId: "approve" } },
  { name: "resolved custom response alone", rows: [custom], result: { approved: false, reason: "no approval request for this revision", requestId: null } },
]) {
  test(`gate query with ${scenario.name}`, async () => {
    const f = fixture(scenario.rows);
    expect(await f.store.gate("run", "plan", 1)).toEqual(scenario.result);
    expect(f.query().replace(/\s+/g, " ")).toContain("WHERE run_id = ? AND phase = ? AND revision = ? AND kind = 'approval' AND (response = 'decline' OR status = 'open' OR (status IN ('resolved', 'acknowledged') AND response = 'approve')) ORDER BY CASE WHEN response = 'decline' THEN 0 WHEN status = 'open' THEN 1 ELSE 2 END, created_at, id LIMIT 1");
  });
}
