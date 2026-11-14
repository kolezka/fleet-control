// A supervisor's cooperative work: reserve one command, then report what happened to it.
// Input that carries one of the caller's own secrets is refused before anything is stored.
import type { CooperativeClaims } from "../data/cooperative-claims.ts";
import type { CooperativeLifecycle } from "../data/cooperative-lifecycle.ts";
import type { CooperativeStatus } from "../domain/cooperative.ts";
import type { IncarnationCredential, Principal } from "../domain/identity.ts";

// The caller must authenticate the principal, validate the credential and pass private copies of both.
// `refuse` lists other secrets the caller holds for this request; ones shorter than 16 characters are not checked.
export function cooperativeSupervisor(deps: { claims: CooperativeClaims; lifecycle: CooperativeLifecycle }, identity: Principal, incarnation: IncarnationCredential, refuse?: readonly string[]) {
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

    async report(commandId: string, requestId: string, status: CooperativeStatus, detail: string) {
      if ([commandId, requestId, detail].some(sensitive)) throw new Error("sensitive request");
      return deps.lifecycle.report(identity, incarnation, commandId, requestId, status, detail);
    },
  };
}
