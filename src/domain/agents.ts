// Claude Code agents the operator starts from the panel. The host owns them: it writes their fleet rows,
// starts them with agent-fleet and stops them. These are the rules; the adapter does the work.

export type AgentState = "starting" | "running" | "failed" | "stopping" | "stopped";

export type Agent = {
  name: string; // tmux session, always prefixed with fc-
  cwd: string; // real path inside an allowed root
  model: string;
  promptSha256: string;
  promptBytes: number;
  createdBy: string;
  createdAt: string;
  state: AgentState;
  error: string | null;
  updatedAt: string;
};

export type AgentSpec = { name: string; cwd: string; model: string; prompt: string };

export type AgentErrorKind = "invalid" | "conflict" | "not_found" | "unavailable";
export class AgentError extends Error {
  constructor(readonly kind: AgentErrorKind, message: string) {
    super(message);
    this.name = "AgentError";
  }
}

// Managed sessions share the fleet's tmux socket with hand-made ones; the prefix keeps them apart,
// so the panel can never stop a session it did not start.
export const AGENT_PREFIX = "fc-";
export const AGENT_NAME = /^fc-[a-z0-9][a-z0-9-]{0,30}$/;
export const MAX_PROMPT_BYTES = 16 * 1024;
export const DEFAULT_MODELS = ["sonnet", "opus", "haiku"] as const;

export function checkSpec(spec: { name?: unknown; cwd?: unknown; model?: unknown; prompt?: unknown; confirm?: unknown }, models: readonly string[]): AgentSpec {
  const { name, cwd, model, prompt, confirm } = spec;
  if (typeof name !== "string" || !AGENT_NAME.test(name)) throw new AgentError("invalid", "name must be fc- followed by 1 to 31 lowercase letters, digits or dashes");
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new AgentError("invalid", "cwd must be an absolute path");
  if (typeof model !== "string" || !models.includes(model)) throw new AgentError("invalid", `model must be one of ${models.join(", ")}`);
  if (typeof prompt !== "string" || prompt.trim() === "") throw new AgentError("invalid", "prompt is required");
  if (new TextEncoder().encode(prompt).length > MAX_PROMPT_BYTES) throw new AgentError("invalid", `prompt is longer than ${MAX_PROMPT_BYTES} bytes`);
  // The start runs an unattended agent; the caller repeats the name to show it was confirmed.
  if (confirm !== name) throw new AgentError("invalid", "confirm must repeat the agent name");
  return { name, cwd, model, prompt };
}

// A row may be started again only once nothing of it runs.
export const restartable = (state: AgentState) => state === "failed" || state === "stopped";
// A stopping row may be stopped again: its earlier stop may have been cut off by a restart.
export const stoppable = (state: AgentState) => state !== "stopped";
// Only these keep a fleet row. A failed, stopping or stopped agent has none, so a watchdog started later
// does not recreate it.
export const keepsFleetRow = (state: AgentState) => state === "starting" || state === "running";

// After a service restart nothing is waiting on a starting or stopping row any more.
// alive: the agent's tmux session exists now.
export function recovered(state: AgentState, alive: boolean): { state: AgentState; error: string | null } | null {
  if (state === "starting") return alive ? { state: "running", error: null } : { state: "failed", error: "start interrupted by a service restart" };
  if (state === "stopping") return alive ? { state: "failed", error: "stop interrupted by a service restart; stop it again" } : { state: "stopped", error: null };
  return null;
}

export type FleetRow = Pick<Agent, "name" | "cwd" | "model">;

// What the host needs from the machine to run agents. src/fleet/agents.ts implements it over agent-fleet.
export interface AgentLauncher {
  // The real directory, if it is inside an allowed root; otherwise AgentError invalid.
  resolveDir(path: string): Promise<string>;
  // Directories directly under each allowed root, for the panel's picker.
  folders(): Promise<string[]>;
  // Writes the prompt and the fleet rows, then starts this one. `rows` is read when the file is written, so
  // a change made while an earlier write waited is not undone. It must include this agent.
  start(agent: AgentSpec, rows: () => FleetRow[]): Promise<void>;
  // Ends the tmux session and rewrites the rows. Does not wait for a start in progress.
  stop(name: string, rows: () => FleetRow[]): Promise<void>;
  // Rewrites the managed fleet rows to what `rows` returns when the write runs.
  rewrite(rows: () => FleetRow[]): Promise<void>;
  // Names of managed sessions that have a tmux session now.
  running(): Promise<Set<string>>;
}
