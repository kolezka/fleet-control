// The host side of fleet administration: the fleet.conf file, bash, the logs and the fleet CLI.
import { chmod, copyFile, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConfFacts, FleetHost } from "../application/fleet-admin.ts";
import type { LogSource } from "../domain/fleet-admin.ts";

type Run = { exitCode: number; stdout: string; stderr: string };
const tail = (s: string) => s.slice(-16_384);

async function run(argv: string[], opts: { stdin?: string; env?: Record<string, string>; timeoutMs: number }): Promise<Run> {
  const p = Bun.spawn(argv, {
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe", stderr: "pipe", detached: true,
    env: { ...process.env, TMUX: undefined, ...opts.env },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); } }, opts.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return timedOut ? { exitCode: 124, stdout: tail(stdout), stderr: `${tail(stderr)}\ntimed out after ${opts.timeoutMs} ms` } : { exitCode, stdout: tail(stdout), stderr: tail(stderr) };
  } finally {
    clearTimeout(timer);
  }
}

// Where the service's own log is: a file, or journal:<unit> for a systemd user unit.
export type ServiceLog = { file: string } | { unit: string };
export function serviceLogFromEnv(value: string | undefined): ServiceLog | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (v.startsWith("journal:")) {
    const unit = v.slice("journal:".length);
    if (!/^[A-Za-z0-9@._-]{1,128}$/.test(unit)) throw new Error("FLEET_CONTROL_SERVICE_LOG: journal:<unit> needs a plain unit name");
    return { unit };
  }
  if (!/^\/[^\0\n]+$/.test(v)) throw new Error("FLEET_CONTROL_SERVICE_LOG must be an absolute file path or journal:<unit>");
  return { file: v };
}

// Reads the values a fleet.conf sets. It runs the file, as agent-fleet does each time it loads it.
const FACTS = '. "$0" >/dev/null 2>&1 || exit 3; printf "%s\\0%s\\0%s\\0%s\\0" "${FLEET:-}" "${FLEET_DIR:-}" "${FLEET_TMUX_SOCKET-fleet-${FLEET:-}}" "${REMOTE_SSH:-}"; for r in "${AGENTS[@]}"; do printf "%s\\0" "${r%%|*}"; done';

export class FleetAdminHost implements FleetHost {
  constructor(readonly opts: { confPath: string; fleetBin: string; serviceLog?: ServiceLog; tmuxBin?: string; restartTimeoutMs?: number }) {}
  get path() { return this.opts.confPath; }

  read() { return readFile(this.opts.confPath, "utf8"); }

  async syntax(text: string) {
    const r = await run(["bash", "-n"], { stdin: text, timeoutMs: 5_000 });
    return r.exitCode === 0 ? null : (r.stderr.trim().replace(/^bash: /gm, "") || `exit ${r.exitCode}`);
  }

  // The text is written to a private temp file beside the real one, so relative sources resolve the same way.
  async facts(text: string): Promise<ConfFacts> {
    const tmp = join(dirname(this.opts.confPath), `.fleet.conf.check-${randomUUID()}`);
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(text);
      await fh.close();
      const r = await run(["bash", "-c", FACTS, tmp], { timeoutMs: 5_000 });
      // agent-fleet sources it under set -e, so a failing last command breaks every fleet call.
      if (r.exitCode !== 0) throw new Error(r.exitCode === 124 ? "loading it took longer than 5 s" : "sourcing it with bash failed; agent-fleet runs it under set -e, so its last command must succeed");
      const [fleet = "", dir = "", socket = "", remote = "", ...rest] = r.stdout.split("\0");
      return { fleet, dir, socket, remote, sessions: rest.filter(Boolean) };
    } finally {
      await fh.close().catch(() => undefined);
      await rm(tmp, { force: true });
    }
  }

  async replace(current: string, text: string) {
    const path = this.opts.confPath;
    const mode = (await stat(path)).mode & 0o777;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const backup = join(dirname(path), `${basename(path)}.bak-${stamp}-${randomUUID().slice(0, 8)}`);
    // copyFile keeps the file's mode, so the backup is as private as fleet.conf.
    await copyFile(path, backup);
    const tmp = join(dirname(path), `.${basename(path)}.new-${randomUUID()}`);
    const fh = await open(tmp, "wx", mode);
    try {
      await fh.writeFile(text);
      await fh.sync();
      await fh.close();
      await chmod(tmp, mode);
      // Last look: a hand edit since the check wins over the page.
      if ((await readFile(path, "utf8")) !== current) throw new Error("fleet.conf changed on the host during the save; nothing was written");
      await rename(tmp, path);
    } catch (e) {
      await fh.close().catch(() => undefined);
      await rm(tmp, { force: true });
      throw e;
    }
    return backup;
  }

  async log(source: LogSource, lines: number) {
    if (source === "watchdog") {
      const r = await run([this.opts.fleetBin, "log", String(lines)], { env: { FLEET_CONF: this.opts.confPath }, timeoutMs: 10_000 });
      if (r.exitCode !== 0 && !/No such file/.test(r.stderr)) throw new Error(`fleet log failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
      return r.stdout;
    }
    const log = this.opts.serviceLog;
    if (!log) throw new Error("the service log is not set up on this host (FLEET_CONTROL_SERVICE_LOG)");
    const r = "file" in log
      ? await run(["tail", "-n", String(lines), log.file], { timeoutMs: 10_000 })
      : await run(["journalctl", "--user", "-u", log.unit, "-n", String(lines), "--no-pager", "-o", "short-iso"], { timeoutMs: 10_000 });
    if (r.exitCode !== 0) throw new Error(`service log could not be read: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    return r.stdout;
  }

  async restart(session: string) {
    const env = { FLEET_CONF: this.opts.confPath };
    const facts = await this.facts(await this.read());
    const tmux = this.opts.tmuxBin ?? "tmux";
    const socket = facts.socket ? ["-L", facts.socket] : [];
    // Ending a session that is not running is fine: the start below brings it up either way.
    const k = await run([tmux, ...socket, "kill-session", "-t", `=${session}`], { timeoutMs: 10_000 });
    if (k.exitCode !== 0 && !/can't find session|no server running|error connecting to/.test(k.stderr)) {
      return { ok: false, output: `tmux kill-session failed: ${k.stderr.trim()}` };
    }
    const s = await run([this.opts.fleetBin, "start", session], { env, timeoutMs: this.opts.restartTimeoutMs ?? 150_000 });
    return { ok: s.exitCode === 0, output: `${s.stdout}${s.stderr}` };
  }
}
