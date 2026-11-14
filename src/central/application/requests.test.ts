import { expect, test } from "bun:test";
import { RequestError } from "../../domain/requests.ts";
import type { CentralRequests } from "../data/requests.ts";
import type { Principal } from "../domain/identity.ts";
import { runOwner } from "../domain/requests.ts";
import { operatorRequests, supervisorRequests } from "./requests.ts";

const operator = { name: "op", role: "operator" } as const;
const supervisor = { name: "sup", role: "supervisor", principalId: "p-1", hostId: "host", session: "session" } as const satisfies Principal;
const owner = runOwner(supervisor);

test("the owner record names the whole identity and is shown as the supervisor's name", async () => {
  expect(owner).toBe("central-supervisor\n" + JSON.stringify(["sup", "p-1", "host", "session"]));
  const requests = {
    list: async () => ({ requests: [{ id: "r-1", origin: owner }], nextCursor: "next" }),
    runs: async () => [{ id: "run-1", orchestrator: owner }, { id: "run-2", orchestrator: "someone" }],
    get: async () => ({ id: "r-1", origin: owner }),
  } as unknown as CentralRequests;
  const use = operatorRequests(requests, operator);
  expect(await use.list({})).toEqual({
    runs: [{ id: "run-1", orchestrator: "sup" }, { id: "run-2", orchestrator: "someone" }],
    requests: [{ id: "r-1", origin: "sup" }],
    nextCursor: "next",
  } as never);
  expect(await use.get("r-1")).toEqual({ id: "r-1", origin: "sup" } as never);
});

test("an operator's answer is recorded under the operator's name", async () => {
  const seen: unknown[] = [];
  const requests = { resolve: async (input: unknown) => { seen.push(input); return { id: "r-1", origin: "x" }; } } as unknown as CentralRequests;
  await operatorRequests(requests, operator).resolve({ requestId: "r-1", response: "yes", expectedRevision: 2 });
  expect(seen).toEqual([{ requestId: "r-1", response: "yes", expectedRevision: 2, actor: "op" }]);
});

function fenced() {
  const calls: unknown[][] = [];
  const guarded: unknown[][] = [];
  const guard = async (...args: unknown[]) => { guarded.push(args); return true; };
  const record = (name: string, result: unknown) => async (...args: unknown[]) => {
    calls.push([name, ...args.filter((arg) => typeof arg !== "function")]);
    for (const arg of args) if (typeof arg === "function") await (arg as (tx: unknown) => Promise<void>)("tx");
    return result;
  };
  const requests = {
    registerRun: record("registerRun", { id: "run-1", orchestrator: owner }),
    updatePhase: record("updatePhase", { run: { id: "run-1", orchestrator: owner }, staled: ["r-0"] }),
    create: record("create", { id: "r-1", origin: owner }),
    acknowledge: record("acknowledge", { id: "r-1", origin: owner }),
    withdraw: record("withdraw", { id: "r-1", origin: owner }),
    gateScoped: record("gateScoped", { approved: false, reason: "none", requestId: null }),
  } as unknown as CentralRequests;
  return { use: supervisorRequests(requests, supervisor, guard as never), calls, guarded };
}

test("every supervisor operation acts as the owner derived from its identity and runs the guard", async () => {
  const { use, calls, guarded } = fenced();
  expect(await use.registerRun({ runId: "run-1", phase: "plan" })).toEqual({ id: "run-1", orchestrator: "sup" } as never);
  expect(await use.updatePhase({ runId: "run-1", expectedRevision: 1, phaseStatus: "working", newRevision: false })).toEqual({ run: { id: "run-1", orchestrator: "sup" }, staled: ["r-0"] } as never);
  expect(await use.create({ runId: "run-1", expectedRevision: 1, kind: "approval", question: "ok?" })).toEqual({ id: "r-1", origin: "sup" } as never);
  expect(await use.acknowledge({ requestId: "r-1" })).toEqual({ id: "r-1", origin: "sup" } as never);
  expect(await use.withdraw({ requestId: "r-1", reason: "done" })).toEqual({ id: "r-1", origin: "sup" } as never);
  expect(await use.gate("run-1", "plan", 1)).toEqual({ approved: false, reason: "none", requestId: null });
  expect(calls).toEqual([
    ["registerRun", { runId: "run-1", phase: "plan", orchestrator: owner }],
    ["updatePhase", { runId: "run-1", expectedRevision: 1, phaseStatus: "working", newRevision: false, actor: owner }],
    ["create", { runId: "run-1", expectedRevision: 1, kind: "approval", question: "ok?", origin: owner }],
    ["acknowledge", { requestId: "r-1", actor: owner }],
    ["withdraw", { requestId: "r-1", reason: "done", actor: owner }],
    ["gateScoped", "run-1", "plan", 1, owner],
  ]);
  expect(guarded).toEqual(Array(6).fill(["tx", { hostId: "host", session: "session" }]));
});

test("someone else's run and a missing run look the same; other errors pass through", async () => {
  const failing = (error: Error) => supervisorRequests({ acknowledge: async () => { throw error; } } as unknown as CentralRequests, supervisor, (async () => true) as never);
  await expect(failing(new RequestError("not_found", "request r-1 not found")).acknowledge({ requestId: "r-1" })).rejects.toThrow(/^access denied$/);
  await expect(failing(new RequestError("forbidden", "not the owner")).acknowledge({ requestId: "r-1" })).rejects.toThrow(/^access denied$/);
  const conflict = new RequestError("conflict", "already acknowledged");
  await expect(failing(conflict).acknowledge({ requestId: "r-1" })).rejects.toBe(conflict);
});
