// Role-scoped access to central commands. An operator reads every command and submits new ones;
// a supervisor reads and answers only commands for its own host and session, and only while its identity is active.
import type { CommandStatus } from "../../domain/commands.ts";
import type { SupervisorReadGuard } from "../data/commands.ts";
import type { SupervisorIdentityRegistry } from "../data/identity-registry.ts";
import type { CentralCommand, CentralCommandInput, CommandListPagination, CommandListScope, CommandPage, SupervisorCommandScope } from "../domain/commands.ts";
import { supervisorIdentity, type Principal } from "../domain/identity.ts";

// What the use cases need from a command store. The scoped methods are optional: a store without them serves operators only.
export type CentralCommandStore = {
  submit(input: CentralCommandInput): Promise<{ command: CentralCommand; created: boolean }>;
  get(id: string): Promise<CentralCommand>;
  list(status?: CommandStatus, scope?: CommandListScope, pagination?: CommandListPagination): Promise<CommandPage>;
  transition(id: string, to: CommandStatus, actor: string, detail: string): Promise<CentralCommand>;
  transitionScoped?(id: string, to: "accepted" | "rejected" | "running" | "completed" | "failed", actor: string, detail: string, scope: SupervisorCommandScope, guard: SupervisorReadGuard): Promise<CentralCommand>;
  getScoped?(id: string, scope: SupervisorCommandScope, guard: SupervisorReadGuard): Promise<CentralCommand>;
  listScoped?(status: CommandStatus | undefined, scope: SupervisorCommandScope, guard: SupervisorReadGuard, pagination?: CommandListPagination): Promise<CommandPage>;
};

// The principal must come from authentication and must not change afterwards; pass a private copy.
export function commandAccess(deps: { commands: CentralCommandStore; identities?: Pick<SupervisorIdentityRegistry, "lockActive"> }, principal: Principal) {
  const { commands } = deps;
  const identity = principal.role === "supervisor" ? supervisorIdentity(principal) : undefined;
  // Runs inside the store's transaction, so a retirement cannot slip between this check and the read or write.
  const guard: SupervisorReadGuard = async (tx) => {
    if (!identity || !deps.identities || await deps.identities.lockActive(tx, identity) !== true) throw new Error("access denied");
    return true;
  };
  const answer = async (id: string, to: "accepted" | "rejected" | "running" | "completed" | "failed", detail: string) => {
    if (!commands.transitionScoped || !identity) throw new Error("access denied");
    return commands.transitionScoped(id, to, identity.name, detail, { hostId: identity.hostId, session: identity.session }, guard);
  };

  return {
    guard,

    async submit(input: Omit<CentralCommandInput, "actor">) {
      if (principal.role !== "operator") throw new Error("access denied");
      return commands.submit({ ...input, actor: principal.name });
    },

    async read(id: string): Promise<CentralCommand> {
      if (principal.role === "operator") return commands.get(id);
      if (!identity || !commands.getScoped) throw new Error("access denied");
      return commands.getScoped(id, { hostId: identity.hostId, session: identity.session }, guard);
    },

    async list(status: CommandStatus | undefined, page: CommandListPagination): Promise<CommandPage> {
      if (principal.role === "operator") return commands.list(status, undefined, page);
      if (!identity || !commands.listScoped) throw new Error("access denied");
      return commands.listScoped(status, { hostId: identity.hostId, session: identity.session }, guard, page);
    },

    respond: (id: string, decision: "accepted" | "rejected", reason: string) => answer(id, decision, reason || decision),
    report: (id: string, status: "running" | "completed" | "failed", evidence: string) => answer(id, status, evidence),
  };
}
