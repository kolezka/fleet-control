// Start and stop Claude Code and DSH agents on this host. Only an operator may; the start is confirmed by name,
// the folder must be inside an allowed root and the prompt may not carry a token.
import { createHash } from "node:crypto";
import type { Agents } from "../data/agents.ts";
import { AgentError, checkSpec, keepsFleetRow, recovered, restartable, stoppable, type Agent, type AgentLauncher, type AgentModels } from "../domain/agents.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";

export type AgentDeps = {
  agents: Agents;
  launcher: AgentLauncher;
  models: AgentModels;
  now?: () => Date;
  carriesSecret?: (text: string) => boolean;
  // Where background failures go (a rewrite or a second stop after the reply was sent). Default: console.error.
  warn?: (message: string) => void;
};

// alive: a tmux session with this name exists now. A running row without one has exited.
export type AgentView = Agent & { alive: boolean };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export function agentUseCases(deps: AgentDeps, caller?: Caller) {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const warn = deps.warn ?? ((m: string) => console.error(m));
  // Rows that still own a fleet entry, read when the launcher writes the file.
  const fleetRows = () => deps.agents.list().filter((a) => keepsFleetRow(a.state)).map(({ name, kind, cwd, model }) => ({ name, kind, cwd, model }));

  return {
    models: deps.models,

    async list(): Promise<AgentView[]> {
      const alive = await deps.launcher.running();
      return deps.agents.list().map((a) => ({ ...a, alive: alive.has(a.name) }));
    },

    folders: () => deps.launcher.folders(),

    // Run once when the service starts: settle rows a restart left starting or stopping, then rewrite
    // the fleet rows so failed agents lose theirs. Returns the names that changed.
    async recover(): Promise<string[]> {
      const alive = await deps.launcher.running();
      const changed: string[] = [];
      for (const a of deps.agents.list()) {
        const next = recovered(a.state, alive.has(a.name));
        if (next && deps.agents.transition(a.name, [a.state], next.state, next.error, now())) changed.push(a.name);
      }
      await deps.launcher.rewrite(fleetRows);
      return changed;
    },

    // Claims the name, then launches in the background: agent-fleet waits up to 90 s for the agent.
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
        name: spec.name, kind: spec.kind, cwd, model: spec.model,
        promptSha256: createHash("sha256").update(spec.prompt).digest("hex"),
        promptBytes: new TextEncoder().encode(spec.prompt).length,
        createdBy: caller?.name ?? "local", createdAt: at, state: "starting", error: null, updatedAt: at,
      };
      if (!deps.agents.claim(agent)) throw new AgentError("conflict", `agent ${spec.name} was started by another request`);
      const launched = deps.launcher.start({ ...spec, cwd }, fleetRows).then(
        async () => {
          if (deps.agents.transition(spec.name, ["starting"], "running", null, now(), at)) return;
          // Stopped (or its stop failed) while it was starting: the stop may have run before the session
          // existed. End the session this launch made, unless a newer start owns the name now.
          if (deps.agents.get(spec.name)?.createdAt !== at) return;
          await deps.launcher.stop(spec.name, fleetRows).catch((e) => warn(`agent ${spec.name}: stop after a late start failed: ${message(e)}`));
        },
        async (e) => {
          if (deps.agents.transition(spec.name, ["starting"], "failed", message(e), now(), at)) {
            await deps.launcher.rewrite(fleetRows).catch((e2) => warn(`agent ${spec.name}: fleet rows not rewritten after a failed start: ${message(e2)}`));
          }
        },
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
        // The row is stopping now, so the rows written here already leave it out.
        await deps.launcher.stop(name, fleetRows);
      } catch (e) {
        if (deps.agents.transition(name, ["stopping"], "failed", `stop failed: ${message(e)}`, now())) {
          await deps.launcher.rewrite(fleetRows).catch((e2) => warn(`agent ${name}: fleet rows not rewritten after a failed stop: ${message(e2)}`));
        }
        throw e;
      }
      deps.agents.transition(name, ["stopping"], "stopped", null, now());
      return deps.agents.get(name)!;
    },
  };
}
