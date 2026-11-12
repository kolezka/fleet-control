import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { RequestError } from "../requests.ts";
import { CentralRequests } from "./requests.ts";

function fixture(runId = "run", phase = "plan", owner = "owner") {
  const calls: { query: string; values: unknown[] }[] = [];
  let transactions = 0;
  let guards = 0;
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    calls.push({ query, values });
    if (query.includes("FROM central_runs")) return [{ id: runId, orchestrator: owner, phase, revision: 1 }];
    if (query.includes("FROM central_requests") && query.includes("WHERE id")) return [{ id: values[0], evidence: "[]", allowedResponses: "[]" }];
    return [];
  }) as unknown as SQL;
  sql.begin = (async (fn: (tx: SQL) => Promise<unknown>) => {
    transactions++;
    return fn(sql);
  }) as typeof sql.begin;
  return {
    store: new CentralRequests(sql), calls,
    guard: async () => { guards++; },
    counts: () => ({ transactions, guards }),
  };
}

for (const [name, value] of [["NUL", "a\0b"], ["unpaired high surrogate", "a\ud800b"], ["unpaired low surrogate", "a\udc00b"]] as const) {
  for (const method of ["run", "get", "gate runId", "gate phase", "gateScoped runId", "gateScoped phase", "gateScoped owner"] as const) {
    test(`${method} rejects ${name} before SQL or transaction`, async () => {
      const f = fixture();
      let error: unknown;
      try {
        if (method === "run") await f.store.run(value);
        else if (method === "get") await f.store.get(value);
        else if (method === "gate runId") await f.store.gate(value, "plan", 1);
        else if (method === "gate phase") await f.store.gate("run", value, 1);
        else await f.store.gateScoped(method === "gateScoped runId" ? value : "run", method === "gateScoped phase" ? value : "plan", 1, method === "gateScoped owner" ? value : "owner", f.guard);
      } catch (caught) { error = caught; }
      expect(f.calls).toEqual([]);
      expect(f.counts()).toEqual({ transactions: 0, guards: 0 });
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).kind).toBe("invalid");
    });
  }
}

for (const [name, value] of [["replacement character", "a\ufffdb"], ["supplementary character", "a\ud83d\ude00b"]] as const) {
  for (const method of ["run", "get", "gate runId", "gate phase", "gateScoped runId", "gateScoped phase", "gateScoped owner"] as const) {
    test(`${method} accepts valid ${name} unchanged`, async () => {
      const runId = method.endsWith("runId") || method === "run" ? value : "run";
      const phase = method.endsWith("phase") ? value : "plan";
      const owner = method.endsWith("owner") ? value : "owner";
      const f = fixture(runId, phase, owner);
      if (method === "run") expect((await f.store.run(value)).id).toBe(value);
      else if (method === "get") expect((await f.store.get(value)).id).toBe(value);
      else {
        const result = method.startsWith("gateScoped")
          ? await f.store.gateScoped(runId, phase, 1, owner, f.guard)
          : await f.store.gate(runId, phase, 1);
        expect(result).toEqual({ approved: false, reason: "no approval request for this revision", requestId: null });
        expect(f.counts()).toEqual({ transactions: 1, guards: method.startsWith("gateScoped") ? 1 : 0 });
      }
      if (!method.endsWith("owner")) expect(f.calls.some((call) => call.values.includes(value))).toBe(true);
      else expect(f.calls.some((call) => call.query.includes("FROM central_requests"))).toBe(true);
    });
  }
}
