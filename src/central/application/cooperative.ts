// A supervisor's cooperative work: reserve one command, then report what happened to it.
// Input that carries one of the caller's own secrets is refused before anything is stored.
import type { CooperativeClaims } from "../data/cooperative-claims.ts";
import type { CooperativeInspection } from "../data/cooperative-inspection.ts";
import type { CooperativeLifecycle } from "../data/cooperative-lifecycle.ts";
import type { CooperativeReconciliation } from "../data/cooperative-reconciliation.ts";
import type { CooperativeSettlement } from "../data/cooperative-settlement.ts";
import type { CooperativeStatus, SettlementDisposition } from "../domain/cooperative.ts";
import type { IncarnationCredential, Principal } from "../domain/identity.ts";

// The caller must authenticate the principal, validate the credential and pass private copies of both.
// `refuse` lists other secrets the caller holds for this request; ones shorter than 16 characters are not checked.
// Longest wait a supervisor may ask for. It stays under the adapter's 30 second request deadline.
export const MAX_WAIT_SECONDS = 20;
const POLL_MS = 1000;

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
const realClock: Clock = { now: () => performance.now(), sleep: (ms) => Bun.sleep(ms) };

export function cooperativeSupervisor(deps: { claims: CooperativeClaims; lifecycle: CooperativeLifecycle; clock?: Clock }, identity: Principal, incarnation: IncarnationCredential, refuse?: readonly string[]) {
  const refused = [incarnation.token, ...(refuse ?? []).filter((secret) => typeof secret === "string" && secret.length >= 16)];
  const sensitive = (value: string) => refused.some((secret) => value.includes(secret));

  return {
    async claim(requestId: string) {
      if (sensitive(requestId)) throw new Error("sensitive request");
      return deps.claims.claim(identity, incarnation, requestId, (command) => {
        const response = JSON.stringify({ command });
        return !response.includes(incarnation.token) && !response.includes(incarnation.incarnationId);
      });
    },

    // Waits up to waitSeconds for work on this slot without claiming it, so an idle host process
    // can start an agent only when there is something to do. The agent still claims for itself.
    async wait(waitSeconds: number, signal?: AbortSignal) {
      if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) throw new Error("invalid wait");
      const clock = deps.clock ?? realClock;
      const deadline = clock.now() + waitSeconds * 1000;
      while (true) {
        if (await deps.claims.pending(identity, incarnation)) return { pending: true };
        const left = deadline - clock.now();
        if (left <= 0 || signal?.aborted) return { pending: false };
        await clock.sleep(Math.min(POLL_MS, left));
      }
    },

    async report(commandId: string, requestId: string, status: CooperativeStatus, detail: string) {
      if ([commandId, requestId, detail].some(sensitive)) throw new Error("sensitive request");
      return deps.lifecycle.report(identity, incarnation, commandId, requestId, status, detail);
    },
  };
}

type Page = { limit: number; cursor?: string };

// An operator's view of cooperative work: inspect a command, list the assertions made about it,
// and read or record its settlement. Only an operator may; a store that was not provided is refused too.
export function cooperativeOperator(deps: {
  inspection?: Pick<CooperativeInspection, "inspectBounded">;
  reconciliation?: Pick<CooperativeReconciliation, "listBounded">;
  settlement?: Pick<CooperativeSettlement, "get" | "settle">;
}, principal: Principal) {
  const allowed = <T>(store: T | undefined): T => {
    if (!principal || principal.role !== "operator" || store === undefined) throw new Error("access denied");
    return store;
  };
  return {
    inspect: async (commandId: string, page: Page) => allowed(deps.inspection).inspectBounded(commandId, page),
    assertions: async (commandId: string, page: Page) => allowed(deps.reconciliation).listBounded(principal, commandId, page),
    settlement: async (commandId: string) => allowed(deps.settlement).get(principal, commandId),
    settle: async (commandId: string, input: { requestId: string; disposition: SettlementDisposition; evidence: string; expectedSequence: string | null }) =>
      allowed(deps.settlement).settle(principal, commandId, input.requestId, input.disposition, input.evidence, input.expectedSequence),
  };
}
