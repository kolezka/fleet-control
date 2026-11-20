// Managed Claude Code and DSH agents in the supervisor panel: parsing the host's answer and gating the start form.
// Pure functions only, so the rules are tested without a DOM.

export type AgentKind = "claude" | "dsh";
export const KIND_LABEL: Record<AgentKind, string> = { claude: "Claude Code", dsh: "DSH" };
export type AgentRow = {
  name: string; kind: AgentKind; cwd: string; model: string; state: "starting" | "running" | "failed" | "stopping" | "stopped";
  error: string | null; createdBy: string; updatedAt: string; alive: boolean; orchestrator: boolean;
};
// kinds: models per kind this host offers. A host from before DSH agents sends only models (Claude Code).
// orchestrators: the host can give a Claude Code agent its own token and this host's MCP, for a phased run.
export type AgentList = { agents: AgentRow[]; kinds: Partial<Record<AgentKind, string[]>>; folders: string[]; orchestrators: boolean };
export type AgentForm = { name: string; kind: AgentKind; cwd: string; model: string; prompt: string; confirm: string; orchestrator: boolean };

const STATES = new Set(["starting", "running", "failed", "stopping", "stopped"]);
const str = (v: unknown): v is string => typeof v === "string";

export function parseAgents(body: unknown): AgentList | null {
  const b = body as { agents?: unknown; models?: unknown; kinds?: unknown; folders?: unknown; orchestrators?: unknown } | null;
  if (!b || !Array.isArray(b.agents) || !Array.isArray(b.models) || !Array.isArray(b.folders)) return null;
  if (!b.models.every(str) || !b.folders.every(str)) return null;
  let kinds: AgentList["kinds"] = { claude: b.models as string[] };
  if (b.kinds !== undefined) {
    if (!b.kinds || typeof b.kinds !== "object" || Array.isArray(b.kinds)) return null;
    kinds = {};
    for (const [k, m] of Object.entries(b.kinds as Record<string, unknown>)) {
      // A kind this panel does not know is left out, not shown as something it cannot start.
      if (!Object.hasOwn(KIND_LABEL, k)) continue;
      if (!Array.isArray(m) || !m.every(str)) return null;
      if (m.length) kinds[k as AgentKind] = m;
    }
  }
  const agents: AgentRow[] = [];
  for (const a of b.agents as Record<string, unknown>[]) {
    if (!a || !str(a.name) || !str(a.cwd) || !str(a.model) || !str(a.state) || !STATES.has(a.state) || !str(a.updatedAt) || typeof a.alive !== "boolean") return null;
    // Rows from before DSH agents have no kind; they are Claude Code agents.
    const kind = a.kind === undefined ? "claude" : a.kind;
    if (kind !== "claude" && kind !== "dsh") return null;
    agents.push({ name: a.name, kind, cwd: a.cwd, model: a.model, state: a.state as AgentRow["state"], error: str(a.error) ? a.error : null, createdBy: str(a.createdBy) ? a.createdBy : "", updatedAt: a.updatedAt, alive: a.alive, orchestrator: a.orchestrator === true });
  }
  // Only an explicit true offers orchestrators; older hosts send nothing.
  return { agents, kinds, folders: b.folders as string[], orchestrators: b.orchestrators === true };
}

// Same rule as src/domain/agents.ts AGENT_NAME; the host checks again.
export const AGENT_NAME = /^fc-[a-z0-9][a-z0-9-]{0,30}$/;
export const MAX_PROMPT_BYTES = 16 * 1024;

export const kindsOf = (l: AgentList | null) => (Object.keys(KIND_LABEL) as AgentKind[]).filter(k => (l?.kinds[k]?.length ?? 0) > 0);
export const modelsFor = (l: AgentList | null, kind: AgentKind) => l?.kinds[kind] ?? [];

export type StartGate = { ok: true } | { ok: false; reason: string };

export function startGate(f: AgentForm, list: AgentList | null, busy: boolean): StartGate {
  if (busy) return { ok: false, reason: "Starting" };
  if (!list) return { ok: false, reason: "Agent list unknown" };
  if (!AGENT_NAME.test(f.name)) return { ok: false, reason: "Name must be fc- and lowercase letters, digits or dashes" };
  const live = list.agents.find(a => a.name === f.name && a.state !== "failed" && a.state !== "stopped");
  if (live) return { ok: false, reason: `${f.name} is ${live.state}` };
  if (!list.folders.includes(f.cwd)) return { ok: false, reason: "Choose a folder" };
  if (!kindsOf(list).includes(f.kind)) return { ok: false, reason: "Choose an agent kind" };
  if (!modelsFor(list, f.kind).includes(f.model)) return { ok: false, reason: "Choose a model" };
  if (f.orchestrator && !list.orchestrators) return { ok: false, reason: "This host does not offer orchestrators" };
  if (f.orchestrator && f.kind !== "claude") return { ok: false, reason: "Only Claude Code agents can be orchestrators" };
  if (!f.prompt.trim()) return { ok: false, reason: "Write the task" };
  if (new TextEncoder().encode(f.prompt).length > MAX_PROMPT_BYTES) return { ok: false, reason: "Task is longer than 16 KiB" };
  if (f.confirm !== f.name) return { ok: false, reason: `Type ${f.name} to confirm` };
  return { ok: true };
}

export function agentStateText(a: AgentRow): string {
  if (a.state === "running" && !a.alive) return "Session gone";
  if (a.state === "failed") return a.error ? `Failed: ${a.error}` : "Failed";
  return { starting: "Starting", running: "Running", stopping: "Stopping", stopped: "Stopped" }[a.state];
}

export const canStop = (a: AgentRow) => a.state === "running" || a.state === "failed" || a.state === "starting";
export const settling = (l: AgentList | null) => !!l?.agents.some(a => a.state === "starting" || a.state === "stopping");
