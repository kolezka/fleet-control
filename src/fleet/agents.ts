// Starts and stops managed Claude Code agents through agent-fleet on this machine.
// The fleet's own fleet.conf gets one marked line that sources a file this service owns. That file adds a row
// per managed agent and, only while FC_AGENT names that agent, sets its folder and Claude Code arguments.
// agent-fleet reads FC_AGENT from the environment of `fleet start`, which reaches the host only when the
// fleet is local (no REMOTE_SSH), so remote fleets are refused.
import { chmod, mkdir, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { AgentError, type AgentLauncher, type AgentSpec, type FleetRow } from "../domain/agents.ts";

export const MANAGED_FILE = "fleet-control-agents.conf";
const INCLUDE_MARK = "# fleet-control managed agents";
const INCLUDE = `${INCLUDE_MARK}\n[ -f "$FLEET_DIR/${MANAGED_FILE}" ] && . "$FLEET_DIR/${MANAGED_FILE}"\n`;
// Paths go into bash unquoted-safe only if they are this plain.
const PLAIN_PATH = /^\/[A-Za-z0-9._\/-]+$/;
export const START_TIMEOUT_MS = 150_000;

// Hard limits appended to every start prompt by agent-fleet. Written only when the fleet has none.
export const AUTONOMY = `Hard limits (Fleet Control managed agent):
- Work only inside your current folder. Do not read, change or delete files outside it.
- Never push to main or master, never force-push, never merge pull requests.
- Never print, copy or store tokens, keys or passwords.
- Do not install software system-wide, change system settings or stop other processes.
- When you finish or are blocked, say so in one short line and stop.
`;

type Run = { exitCode: number; stdout: string; stderr: string };
export type AgentLauncherOptions = {
  fleetBin: string;
  confPath: string;
  roots: string[];
  // Claude Code's state file; the agent's folder is marked trusted there so the start does not stop at the trust dialog.
  claudeState?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

export class FleetAgentLauncher implements AgentLauncher {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly opts: AgentLauncherOptions) {
    if (opts.roots.length === 0) throw new Error("agent roots are empty");
    for (const r of opts.roots) if (!PLAIN_PATH.test(r)) throw new Error(`agent root must be an absolute plain path: ${r}`);
  }

  // One change to the fleet files at a time.
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.queue.then(f, f);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async conf(): Promise<{ dir: string; socket: string; remote: boolean }> {
    const r = await this.run(["bash", "-c", '. "$FLEET_CONF" >/dev/null 2>&1 || exit 3; printf "%s\\n%s\\n%s\\n" "$FLEET_DIR" "${FLEET_TMUX_SOCKET-fleet-$FLEET}" "${REMOTE_SSH:-}"'], 10_000);
    if (r.exitCode !== 0) throw new AgentError("unavailable", "fleet.conf could not be read");
    const [dir = "", socket = "", remote = ""] = r.stdout.split("\n");
    if (!PLAIN_PATH.test(dir)) throw new AgentError("unavailable", "FLEET_DIR in fleet.conf is not a plain absolute path");
    return { dir, socket, remote: remote !== "" };
  }

  private async run(argv: string[], timeoutMs: number, env: Record<string, string> = {}): Promise<Run> {
    const proc = Bun.spawn(argv, {
      env: { ...process.env, ...this.opts.env, FLEET_CONF: this.opts.confPath, ...env },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); } }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (timedOut) return { exitCode: 124, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs} ms` };
      return { exitCode, stdout: stdout.slice(-8192), stderr: stderr.slice(-8192) };
    } finally {
      clearTimeout(timer);
    }
  }

  private tmux(socket: string, args: string[]) {
    return this.run(["tmux", ...(socket ? ["-L", socket, "-f", "/dev/null"] : []), ...args], 10_000);
  }

  async resolveDir(path: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(path);
      if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new AgentError("invalid", `cwd ${path} is not an existing folder`);
    }
    for (const root of this.opts.roots) {
      const r = await realpath(root).catch(() => null);
      if (r && real.startsWith(r + sep) && PLAIN_PATH.test(real)) return real;
    }
    throw new AgentError("invalid", `cwd must be a folder inside ${this.opts.roots.join(" or ")}`);
  }

  async folders(): Promise<string[]> {
    const out: string[] = [];
    for (const root of this.opts.roots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) out.push(join(root, e.name));
    }
    return out.sort();
  }

  async running(): Promise<Set<string>> {
    const { socket } = await this.conf();
    const r = await this.tmux(socket, ["ls", "-F", "#{session_name}"]);
    // No server yet means no sessions.
    return new Set(r.exitCode === 0 ? r.stdout.split("\n").filter((s) => s.startsWith("fc-")) : []);
  }

  private async writeRows(dir: string, rows: FleetRow[]) {
    const lines = [`# Written by Fleet Control for its managed agents. Changes here are overwritten.`];
    for (const r of rows) lines.push(`AGENTS+=("${r.name}|Fleet: ${r.name}|${r.name}.txt")`);
    lines.push('case "${FC_AGENT:-}" in');
    for (const r of rows) lines.push(`  ${r.name}) AGENT_CWD=${r.cwd}; CLAUDE_ARGS="--dangerously-skip-permissions --model ${r.model}" ;;`);
    lines.push("esac", "");
    await atomicWrite(join(dir, MANAGED_FILE), lines.join("\n"));
    const conf = await Bun.file(this.opts.confPath).text();
    if (!conf.includes(INCLUDE_MARK)) await atomicWrite(this.opts.confPath, `${conf.endsWith("\n") ? conf : conf + "\n"}${INCLUDE}`);
  }

  private async trust(cwd: string) {
    const file = this.opts.claudeState ?? join(homedir(), ".claude.json");
    const data = await Bun.file(file).json().catch(() => null) as { projects?: Record<string, Record<string, unknown>> } | null;
    if (!data || typeof data !== "object") throw new AgentError("unavailable", `${file} could not be read`);
    if (data.projects?.[cwd]?.hasTrustDialogAccepted === true) return;
    data.projects ??= {};
    data.projects[cwd] = { ...data.projects[cwd], hasTrustDialogAccepted: true };
    await atomicWrite(file, JSON.stringify(data, null, 2));
  }

  start(agent: AgentSpec, all: FleetRow[]): Promise<void> {
    return this.serial(async () => {
      const { dir, remote } = await this.conf();
      if (remote) throw new AgentError("unavailable", "managed agents need a local fleet (REMOTE_SSH is set)");
      await writeFile(join(dir, `${agent.name}.txt`), agent.prompt.endsWith("\n") ? agent.prompt : agent.prompt + "\n", { mode: 0o600 });
      if (!(await Bun.file(join(dir, "autonomy.txt")).exists())) await writeFile(join(dir, "autonomy.txt"), AUTONOMY, { mode: 0o644 });
      await this.writeRows(dir, all);
      await this.trust(agent.cwd);
      const r = await this.run([this.opts.fleetBin, "start", agent.name], this.opts.timeoutMs ?? START_TIMEOUT_MS, { FC_AGENT: agent.name });
      if (r.exitCode !== 0) {
        const why = (r.stderr.trim().split("\n").pop() ?? "").slice(0, 300);
        throw new AgentError("unavailable", `fleet start exited ${r.exitCode}${why ? `: ${why}` : ""}`);
      }
      if (/already running/.test(r.stdout)) throw new AgentError("conflict", `${agent.name} was already running`);
    });
  }

  stop(name: string, remaining: FleetRow[]): Promise<void> {
    return this.serial(async () => {
      const { dir, socket } = await this.conf();
      const r = await this.tmux(socket, ["kill-session", "-t", `=${name}`]);
      if (r.exitCode !== 0 && !/can't find session|no server running|session not found/.test(r.stderr)) {
        throw new AgentError("unavailable", `tmux kill-session exited ${r.exitCode}`);
      }
      await this.writeRows(dir, remaining);
    });
  }
}

async function atomicWrite(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.fc-${process.pid}-${Date.now()}`;
  const mode = await stat(path).then((s) => s.mode & 0o777, () => 0o644);
  await writeFile(tmp, text, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}
