import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { RequestError } from "../requests.ts";
import { CentralRequests } from "./requests.ts";

const original = { id: "run", orchestrator: "owner", phase: "plan", revision: 1, phaseStatus: "planned", updatedAt: "2026-01-01T00:00:00.000Z" };

function fixture(existing = false) {
  const calls: { query: string; values: unknown[] }[] = [];
  let transactions = 0, guards = 0;
  let run = existing ? original : undefined;
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    calls.push({ query, values });
    if (query.includes("FROM central_request_event_lock")) return [];
    if (query.includes("FROM central_runs")) return run ? [run] : [];
    if (query.includes("INSERT INTO central_runs")) {
      run = { ...original, id: values[0] as string, orchestrator: values[1] as string, phase: values[2] as string, updatedAt: values[3] as string };
      return [];
    }
    if (query.includes("INSERT INTO central_request_events")) return [];
    throw new Error(`Unexpected SQL: ${query}`);
  };
  const db = Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => { transactions++; return fn(sql); } });
  return { store: new CentralRequests(db as unknown as SQL, () => new Date(original.updatedAt)), calls, guard: async () => { guards++; }, counts: () => ({ transactions, guards }) };
}

async function caught(operation: Promise<unknown>) {
  try { await operation; } catch (error) { return error; }
  return undefined;
}

for (const [name, invalid] of [["NUL", "a\0b"], ["unpaired high surrogate", "a\ud800b"], ["unpaired low surrogate", "a\udc00b"]] as const) {
  test(`registerRun rejects orchestrator with ${name} before transaction and guard`, async () => {
    const f = fixture();
    const error = await caught(f.store.registerRun({ runId: "run", orchestrator: invalid, phase: "plan" }, f.guard));
    expect(f.counts()).toEqual({ transactions: 0, guards: 0 });
    expect(f.calls).toEqual([]);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe("invalid");
  });

  test(`registerRun rejects new phase with ${name} after lookup and before insert`, async () => {
    const f = fixture();
    const error = await caught(f.store.registerRun({ runId: "run", orchestrator: "owner", phase: invalid }, f.guard));
    expect(f.counts()).toEqual({ transactions: 1, guards: 1 });
    expect(f.calls.map(({ query }) => query)).toEqual([
      expect.stringContaining("FROM central_request_event_lock"),
      expect.stringContaining("FROM central_runs"),
    ]);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).kind).toBe("invalid");
  });

  test(`registerRun replay ignores phase with ${name}`, async () => {
    const f = fixture(true);
    expect(await f.store.registerRun({ runId: "run", orchestrator: "owner", phase: invalid }, f.guard)).toEqual(original);
    expect(f.counts()).toEqual({ transactions: 1, guards: 1 });
    expect(f.calls.map(({ query }) => query)).toEqual([
      expect.stringContaining("FROM central_request_event_lock"),
      expect.stringContaining("FROM central_runs"),
    ]);
  });
}

for (const [name, value] of [["replacement character", "a\ufffdb"], ["supplementary character", "a\ud83d\ude00b"]] as const) {
  test(`registerRun preserves valid ${name} in actor and phase`, async () => {
    const f = fixture();
    const result = await f.store.registerRun({ runId: "run", orchestrator: value, phase: value }, f.guard);
    expect(result).toEqual({ ...original, orchestrator: value, phase: value });
    expect(f.counts()).toEqual({ transactions: 1, guards: 1 });
    const insert = f.calls.find(({ query }) => query.includes("INSERT INTO central_runs"));
    const event = f.calls.find(({ query }) => query.includes("INSERT INTO central_request_events"));
    expect(insert?.values.slice(0, 3)).toEqual(["run", value, value]);
    expect(event?.values.slice(0, 5)).toEqual([null, "run", "run_registered", value, `phase ${value} revision 1`]);
  });
}
