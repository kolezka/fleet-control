import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { RequestError, type RequestStatus } from "../../domain/requests.ts";
import { CentralRequests } from "./requests.ts";

function fixture() {
  const calls: unknown[][] = [];
  const sql = async (_parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return [];
  };
  return { store: new CentralRequests(sql as unknown as SQL), calls };
}

function cursor(runId: string | null, status: string | null) {
  return Buffer.from(JSON.stringify([
    "2026-01-01T00:00:00.000Z",
    "req-00000000-0000-4000-8000-000000000001",
    runId,
    status,
  ])).toString("base64url");
}

for (const field of ["runId", "status"] as const) {
  for (const [name, value] of [["NUL", "a\0b"], ["unpaired high surrogate", "a\ud800b"], ["unpaired low surrogate", "a\udc00b"]] as const) {
    for (const page of ["first page", "cursor page"] as const) {
      test(`list rejects ${field} ${name} before SQL on ${page}`, async () => {
        const { store, calls } = fixture();
        const runId = field === "runId" ? value : "run-1";
        const status = field === "status" ? value : "open";
        const filter = { runId, status: status as RequestStatus, ...(page === "cursor page" ? { cursor: cursor(runId, status) } : {}) };
        let error: unknown;
        try { await store.list(filter); } catch (caught) { error = caught; }
        expect(calls).toEqual([]);
        expect(error).toBeInstanceOf(RequestError);
        expect((error as RequestError).kind).toBe("invalid");
      });
    }
  }
}

for (const field of ["runId", "status"] as const) {
  for (const [name, value] of [["replacement character", "a\ufffdb"], ["supplementary character", "a\ud83d\ude00b"]] as const) {
    for (const page of ["first page", "cursor page"] as const) {
      test(`list passes valid ${field} ${name} to SQL on ${page}`, async () => {
        const { store, calls } = fixture();
        const runId = field === "runId" ? value : "run-1";
        const status = field === "status" ? value : "open";
        const result = await store.list({ runId, status: status as RequestStatus, ...(page === "cursor page" ? { cursor: cursor(runId, status) } : {}) });
        expect(result).toEqual({ requests: [], nextCursor: null });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.slice(0, 4)).toEqual([runId, runId, status, status]);
      });
    }
  }
}
