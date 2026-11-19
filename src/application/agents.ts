// Start and stop Claude Code agents on this host. Only an operator may; the start is confirmed by name,
// the folder must be inside an allowed root and the prompt may not carry a token.
import { createHash } from "node:crypto";
import type { Agents } from "../data/agents.ts";
import { AgentError, checkSpec, restartable, stoppable, type Agent, type AgentLauncher } from "../domain/agents.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";

export type AgentDeps = {
  agents: Agents;
  launcher: AgentLauncher;
  models: readonly string[];
  now?: () => Date;
  carriesSecret?: (text: string) => boolean;
};

// alive: a tmux session with this name exists now. A running row without one has exited.
export type AgentView = Agent & { alive: boolean };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export function agentUseCases(deps: AgentDeps, caller?: Caller) {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  // Rows that still own a fleet entry: every start rewrites the managed rows from these.
  const fleetRows = () => deps.agents.list().filter((a) => a.state !== "stopped").map(({ name, cwd, model }) => ({ name, cwd, model }));

  return {
    models: deps.models,

    async list(): Promise<AgentView[]> {
      const alive = await deps.launcher.running();
      return deps.agents.list().map((a) => ({ ...a, alive: alive.has(a.name) }));
    },

    folders: () => deps.launcher.folders(),

    // Claims the name, then launches in the background: agent-fleet waits up to 90 s for Claude Code.
    // `launched` settles when the start finished or failed; the reply does not wait for it.
    async start(input: Record<string, unknown>): Promise<{ agent: Agent; launched: Promise<void> }> {
      requirePermission(caller, "operate");
      const spec = checkSpec(input, deps.models);
      if (deps.carriesSecret?.(spec.prompt)) throw new AgentError("invalid", "prompt contains an access token; it was not stored");
      const cwd = await deps.launcher.resolveDir(spec.cwd);
      const existing = deps.agents.get(spec.name);
      if (existing && !restartable(existing.state)) throw new AgentError("conflict", `agent ${spec.name} is ${existing.state}`);
      if ((await deps.launcher.running()).has(spec.name)) throw new AgentError("conflict", `a session named ${spec.name} is already open`);
      const at = now();
      const agent: Agent = {
        name: spec.name, cwd, model: spec.model,
        promptSha256: createHash("sha256").update(spec.prompt).digest("hex"),
        promptBytes: new TextEncoder().encode(spec.prompt).length,
        createdBy: caller?.name ?? "local", createdAt: at, state: "starting", error: null, updatedAt: at,
      };
      if (!deps.agents.claim(agent)) throw new AgentError("conflict", `agent ${spec.name} was started by another request`);
      const launched = deps.launcher.start({ ...spec, cwd }, fleetRows()).then(
        () => { deps.agents.transition(spec.name, ["starting"], "running", null, now()); },
        (e) => { deps.agents.transition(spec.name, ["starting"], "failed", message(e), now()); },
      );
      return { agent, launched };
    },

    async stop(name: string): Promise<Agent> {
      requirePermission(caller, "operate");
      const agent = deps.agents.get(name);
      if (!agent) throw new AgentError("not_found", `no managed agent ${name}`);
      if (!stoppable(agent.state)) throw new AgentError("conflict", `agent ${name} is ${agent.state}`);
      if (!deps.agents.transition(name, [agent.state], "stopping", null, now())) throw new AgentError("conflict", `agent ${name} changed; read it again`);
      try {
        await deps.launcher.stop(name, fleetRows().filter((r) => r.name !== name));
      } catch (e) {
        deps.agents.transition(name, ["stopping"], "failed", `stop failed: ${message(e)}`, now());
        throw e;
      }
      deps.agents.transition(name, ["stopping"], "stopped", null, now());
      return deps.agents.get(name)!;
    },
  };
}
