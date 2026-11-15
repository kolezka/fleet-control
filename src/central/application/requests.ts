// What an operator and a supervisor may do with runs and requests on central.
import { RequestError } from "../../domain/requests.ts";
import type { CentralRequests, RequestMutationGuard } from "../data/requests.ts";
import type { Principal } from "../domain/identity.ts";
import { displayRequest, displayRun, runOwner } from "../domain/requests.ts";

type Requests = CentralRequests;

// An operator reads everything and relays human answers under its own name.
export function operatorRequests(requests: Requests, principal: Extract<Principal, { role: "operator" }>) {
  return {
    // `runs` holds only the runs this page refers to, plus the run asked for; `runs()` pages through all of them.
    async list(filter: Parameters<Requests["list"]>[0]) {
      const page = await requests.list(filter);
      const ids = page.requests.map((request) => request.runId);
      if (filter?.runId !== undefined) ids.push(filter.runId);
      return { runs: (await requests.runsById(ids)).map(displayRun), requests: page.requests.map(displayRequest), nextCursor: page.nextCursor };
    },
    async runs(page: Parameters<Requests["listRuns"]>[0]) {
      const result = await requests.listRuns(page);
      return { runs: result.runs.map(displayRun), nextCursor: result.nextCursor };
    },
    get: async (requestId: string) => displayRequest(await requests.get(requestId)),
    resolve: async (input: Omit<Parameters<Requests["resolve"]>[0], "actor">) => displayRequest(await requests.resolve({ ...input, actor: principal.name })),
  };
}

// A supervisor works only on runs it owns. The owner is derived from the authenticated identity,
// and the store runs the identity guard inside the transaction of every call.
export function supervisorRequests(requests: Requests, principal: Extract<Principal, { role: "supervisor" }>, requestGuard: RequestMutationGuard) {
  // A run the caller does not own looks the same as a run that does not exist.
  const mutation = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (error) {
      if (error instanceof RequestError && (error.kind === "not_found" || error.kind === "forbidden")) throw new Error("access denied");
      throw error;
    }
  };
  const owner = runOwner(principal);

  return {
    registerRun: async (input: Omit<Parameters<Requests["registerRun"]>[0], "orchestrator">) =>
      displayRun(await mutation(() => requests.registerRun({ ...input, orchestrator: owner }, requestGuard))),
    async updatePhase(input: Omit<Parameters<Requests["updatePhase"]>[0], "actor">) {
      const updated = await mutation(() => requests.updatePhase({ ...input, actor: owner }, requestGuard));
      return { ...updated, run: displayRun(updated.run) };
    },
    create: async (input: Omit<Parameters<Requests["create"]>[0], "origin">) =>
      displayRequest(await mutation(() => requests.create({ ...input, origin: owner }, requestGuard))),
    acknowledge: async (input: { requestId: string }) =>
      displayRequest(await mutation(() => requests.acknowledge({ ...input, actor: owner }, requestGuard))),
    withdraw: async (input: { requestId: string; reason: string }) =>
      displayRequest(await mutation(() => requests.withdraw({ ...input, actor: owner }, requestGuard))),
    gate: (runId: string, phase: string, revision: number) => mutation(() => requests.gateScoped(runId, phase, revision, owner, requestGuard)),
  };
}
