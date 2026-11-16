// What the web API and the MCP tools do with runs and supervisor requests on the host.
import type { Requests } from "../data/requests.ts";
import { EVENT_PAGE } from "./commands.ts";

// Without auth, names are self-declared and the orchestrator check only stops mistakes.
// With auth, `principal` is the authenticated caller and replaces them, so a worker token cannot write the phase record.
export function requestUseCases(requests: Requests, principal?: string) {
  const as = <T extends object>(input: T, key: keyof T): T => (principal ? { ...input, [key]: principal } : input);
  return {
    registerRun: (input: Parameters<Requests["registerRun"]>[0]) => requests.registerRun(as(input, "orchestrator")),
    updatePhase: (input: Parameters<Requests["updatePhase"]>[0]) => requests.updatePhase(as(input, "actor")),
    create: (input: Parameters<Requests["create"]>[0]) => requests.create(as(input, "origin")),
    resolve: (input: Parameters<Requests["resolve"]>[0]) => requests.resolve(as(input, "actor")),
    acknowledge: (input: Parameters<Requests["acknowledge"]>[0]) => requests.acknowledge(as(input, "actor")),
    withdraw: (input: Parameters<Requests["withdraw"]>[0]) => requests.withdraw(as(input, "actor")),

    // The page and the request_list tool both show the runs next to the requests.
    overview: (filter: Parameters<Requests["list"]>[0] = {}) => ({ runs: requests.runs(), requests: requests.list(filter) }),

    // One page of requests with only the runs it refers to, plus the run asked for. runPage pages through every run.
    page: (filter: Parameters<Requests["listPage"]>[0] = {}) => {
      const page = requests.listPage(filter);
      const ids = page.requests.map((r) => r.runId);
      if (filter.runId) ids.push(filter.runId);
      return { runs: requests.runsById(ids), requests: page.requests, nextCursor: page.nextCursor };
    },
    runPage: (page: Parameters<Requests["listRuns"]>[0] = {}) => requests.listRuns(page),

    gate: (runId: string, phase: string, revision: number) => requests.gate(runId, phase, revision),
    eventsAfter: (afterSeq: number, limit = EVENT_PAGE) => requests.events(afterSeq, limit),
  };
}
