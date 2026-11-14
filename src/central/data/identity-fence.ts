import type { TransactionSQL } from "bun";
import type { SupervisorReadGuard } from "./commands.ts";
import type { SupervisorIdentityRegistry } from "./identity-registry.ts";
import type { RequestMutationGuard } from "./requests.ts";
import type { SupervisorCommandScope } from "../domain/commands.ts";
import type { SupervisorIdentity } from "../domain/identity.ts";

// The fence for one authenticated supervisor: the scope its stores must use, and the guards those
// stores run inside their own transaction. The guard locks the identity row, so a retirement
// cannot slip between the check and the read or write that follows it.
export type IdentityFence = { scope: SupervisorCommandScope; commands: SupervisorReadGuard; requests: RequestMutationGuard };

// Fails closed: no registry, a scope that is not this identity's, or anything but an active identity is refused.
export function identityFence(registry: Pick<SupervisorIdentityRegistry, "lockActive"> | undefined, identity: SupervisorIdentity): IdentityFence {
  const held = { ...identity };
  const scope = { hostId: held.hostId, session: held.session };
  const locked = async (tx: TransactionSQL) => {
    if (!registry || await registry.lockActive(tx, held) !== true) throw new Error("access denied");
  };
  return {
    scope: { ...scope },
    async commands(tx, used) {
      if (used?.hostId !== scope.hostId || used?.session !== scope.session) throw new Error("access denied");
      await locked(tx);
      return true;
    },
    requests: locked,
  };
}
