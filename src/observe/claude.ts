// Observes which model a Claude Code session in a fleet tmux session actually used.
// Chain: tmux pane pid -> child `claude` process -> <config>/sessions/<pid>.json -> transcript tail.
// Read-only: lists panes and processes, reads files. Never scrapes terminal text.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ModelObservation } from "../domain/model.ts";

export const OBSERVATION_SOURCE = "claude-code transcript";
const TAIL_BYTES = 512 * 1024;

export type ProcessInfo = { pid: number; ppid: number; started: string; args: string };

// Outcomes stay distinct: "no process" and "malformed metadata" must not look alike.
export type Observation =
  | { kind: "observed"; runtimeInstance: string; observation: ModelObservation }
  | { kind: "no_turn_yet"; runtimeInstance: string }
  | { kind: "no_agent_process" }
  | { kind: "unavailable"; reason: string }
  | { kind: "malformed"; runtimeInstance: string | null; reason: string };

export type ClaudeObserverDeps = {
  configDir: string; // CLAUDE_CONFIG_DIR or ~/.claude
  panePids(session: string): Promise<number[] | null>; // null: tmux session missing
  processes(): Promise<ProcessInfo[]>;
};

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

// Newest `claude` child of any pane, like agent-fleet's claude_pid().
export function findClaude(panePids: number[], procs: ProcessInfo[]): ProcessInfo | null {
  const panes = new Set(panePids);
  const hits = procs.filter((p) => panes.has(p.ppid) && /^claude(\s|$)/.test(p.args));
  return hits.sort((a, b) => a.pid - b.pid).at(-1) ?? null;
}

// Claude Code names project folders after the cwd with every non-alphanumeric char as "-".
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

// Last main-thread model in a transcript tail. Sidechain (subagent) turns and synthetic
// messages are skipped so a child model never overwrites the parent.
export function lastMainModel(
  tail: string,
  sessionId: string,
): { model: string; at: string } | { malformed: string } | null {
  const lines = tail.split("\n");
  let parsedAny = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // the first line of a tail is usually cut; a torn last line can be mid-write
    }
    parsedAny = true;
    if (rec?.type !== "assistant" || rec.isSidechain === true) continue;
    if (rec.sessionId !== undefined && rec.sessionId !== sessionId) continue;
    const model = rec.message?.model;
    if (model === "<synthetic>") continue;
    if (typeof model !== "string" || !model || typeof rec.timestamp !== "string" || !Number.isFinite(Date.parse(rec.timestamp))) {
      return { malformed: "assistant record without a model or timestamp" };
    }
    return { model, at: rec.timestamp };
  }
  return parsedAny || !tail.trim() ? null : { malformed: "transcript tail has no JSON records" };
}

async function readTail(path: string, bytes = TAIL_BYTES): Promise<string | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  const fh = await open(path, "r");
  try {
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

export class ClaudeObserver {
  constructor(private readonly deps: ClaudeObserverDeps) {}

  async observe(session: string): Promise<Observation> {
    const panes = await this.deps.panePids(session);
    if (panes === null) return { kind: "unavailable", reason: "tmux session not found" };
    const proc = findClaude(panes, await this.deps.processes());
    if (!proc) return { kind: "no_agent_process" };

    const metaPath = join(this.deps.configDir, "sessions", `${proc.pid}.json`);
    const metaFile = Bun.file(metaPath);
    if (!(await metaFile.exists())) return { kind: "unavailable", reason: `no session file for claude pid ${proc.pid}` };
    let meta: any;
    try {
      meta = await metaFile.json();
    } catch {
      return { kind: "malformed", runtimeInstance: null, reason: `unreadable ${metaPath}` };
    }
    if (meta?.pid !== proc.pid || typeof meta.sessionId !== "string" || typeof meta.cwd !== "string") {
      return { kind: "malformed", runtimeInstance: null, reason: "session file lacks pid, sessionId or cwd" };
    }
    // pid reuse guard: the file must describe this exact process start
    if (typeof meta.procStart === "string" && proc.started && norm(meta.procStart) !== norm(proc.started)) {
      return { kind: "unavailable", reason: `session file for pid ${proc.pid} belongs to an earlier process` };
    }
    const runtimeInstance = `claude:${proc.pid}:${meta.sessionId}`;

    const transcript = join(this.deps.configDir, "projects", projectDirName(meta.cwd), `${meta.sessionId}.jsonl`);
    const tail = await readTail(transcript);
    if (tail === null) return { kind: "no_turn_yet", runtimeInstance };
    const last = lastMainModel(tail, meta.sessionId);
    if (last === null) return { kind: "no_turn_yet", runtimeInstance };
    if ("malformed" in last) return { kind: "malformed", runtimeInstance, reason: last.malformed };
    return {
      kind: "observed",
      runtimeInstance,
      observation: { model: last.model, source: OBSERVATION_SOURCE, observedAt: last.at, runtimeInstance },
    };
  }
}

// --- host adapters ---------------------------------------------------------------

export function fleetSocket(conf: string): string | null {
  const m = conf.match(/^\s*FLEET=["']?([A-Za-z0-9._-]+)["']?\s*$/m);
  return m ? `fleet-${m[1]}` : null;
}

// Pane pids on the fleet's private tmux socket. Only reads; agent-fleet owns the sessions.
export function tmuxPanePids(socket: string) {
  return async (session: string): Promise<number[] | null> => {
    const p = Bun.spawn(["tmux", "-L", socket, "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_pid}"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    return out.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  };
}

// `ps` in the C locale and UTC prints lstart the way Claude Code writes procStart.
export async function psProcesses(): Promise<ProcessInfo[]> {
  const p = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,lstart=,args="], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const procs: ProcessInfo[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), started: m[3]!, args: m[4]! });
  }
  return procs;
}

// Builds an observer for a fleet.conf, or explains why it cannot. The service runs on the
// host that owns the fleet, so a conf that reaches sessions over SSH is not observed here.
export async function observerForConf(confPath: string, home = process.env.HOME ?? ""): Promise<ClaudeObserver | { disabled: string }> {
  const conf = await Bun.file(confPath).text();
  const value = (key: string) => conf.match(new RegExp(`^\\s*${key}=["']?([^"'\\n]*)["']?\\s*$`, "m"))?.[1]?.trim() ?? "";
  if (value("REMOTE_SSH") || value("REMOTE_USER")) return { disabled: "fleet sessions are on another host or user; observe them from that host's service" };
  const socket = fleetSocket(conf);
  if (!socket) return { disabled: "fleet.conf has no FLEET name" };
  const configDir = value("CLAUDE_CONFIG_DIR").replace(/^~(?=\/|$)/, home) || process.env.CLAUDE_CONFIG_DIR || `${home}/.claude`;
  return new ClaudeObserver({ configDir, panePids: tmuxPanePids(socket), processes: psProcesses });
}
