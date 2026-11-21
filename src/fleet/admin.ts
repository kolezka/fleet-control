// The host side of fleet administration: the fleet.conf file, bash, the logs and the fleet CLI.
import { chmod, copyFile, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConfFacts, FleetHost } from "../application/fleet-admin.ts";
import { AdminError, type LogSource } from "../domain/fleet-admin.ts";

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
// Loads it the way agent-fleet does (set -euo pipefail, then the FLEET and FLEET_DIR checks), so a file that
// breaks fleet breaks here. No `|| exit` around the source: that would switch set -e off inside the file.
// A marker line with a fresh nonce, appended after the text, tells a file that stops early (return) from one
// that ran to its end; a trailing "done" tells an `exit` (which ends the whole bash with status 0) apart.
// CONF and LOCAL_DIR are not set: fleet sets them but the watchdog does not, so a file needing them fails here.
const facts = (nonce: string) => `set -euo pipefail; . "$0" >/dev/null 2>&1; [ "\${__FLEET_CONTROL_END-}" = ${nonce} ] || exit 4; : "\${FLEET:?}" "\${FLEET_DIR:?}"; printf "%s\\0%s\\0%s\\0%s\\0" "$FLEET" "$FLEET_DIR" "\${FLEET_TMUX_SOCKET-fleet-$FLEET}" "\${REMOTE_SSH:-}"; for r in "\${AGENTS[@]+"\${AGENTS[@]}"}"; do printf "%s\\0" "\${r%%|*}"; done; printf done`;
// Runs after the file's own lines: it keeps the status of the file's last command, as a plain source would.
const endLine = (nonce: string) => `__fc_status=$?; __FLEET_CONTROL_END=${nonce}; return "$__fc_status"`;
const EARLY_STOP = "it stops before its end (return or exit), so the lines after it, the managed agents among them, never load";

export class FleetAdminHost implements FleetHost {
  constructor(readonly opts: { confPath: string; fleetBin: string; serviceLog?: ServiceLog; tmuxBin?: string; restartTimeoutMs?: number }) {}
  get path() { return this.opts.confPath; }

  read() { return readFile(this.opts.confPath, "utf8"); }

  async syntax(text: string) {
    // bash -n only warns (status 0) about a heredoc left open; that one would swallow the rest of the file.
    const r = await run(["bash", "-n"], { stdin: text, timeoutMs: 5_000, env: { LC_ALL: "C" } });
    const said = r.stderr.trim().replace(/^bash: /gm, "");
    return r.exitCode === 0 && said === "" ? null : (said || `exit ${r.exitCode}`);
  }

  // The text is written to a private temp file beside the real one, so relative sources resolve the same way.
  async facts(text: string): Promise<ConfFacts> {
    const tmp = join(dirname(this.opts.confPath), `.fleet.conf.check-${randomUUID()}`);
    // A last line ending in a backslash would join the marker line; agent-fleet's bash fails on it.
    if (/\\[ \t]*\n?$/.test(text)) throw new Error("its last line ends with a backslash");
    const nonce = randomUUID().replace(/-/g, "");
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(`${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${endLine(nonce)}\n`);
      await fh.close();
      const r = await run(["bash", "-c", facts(nonce), tmp], { timeoutMs: 5_000 });
      if (r.exitCode === 124) throw new Error("loading it took longer than 5 s");
      if (r.exitCode === 4 || (r.exitCode === 0 && !r.stdout.endsWith("done"))) throw new Error(EARLY_STOP);
      // agent-fleet sources it under set -euo pipefail: any failing command or unset variable breaks every fleet call.
      if (r.exitCode !== 0) throw new Error("sourcing it the way agent-fleet does (set -euo pipefail) failed: a command in it fails, a variable is unset, or FLEET or FLEET_DIR is missing");
      const [fleet = "", dir = "", socket = "", remote = "", ...rest] = r.stdout.slice(0, -"done".length).split("\0");
      return { fleet, dir, socket, remote, sessions: rest.filter(Boolean) };
    } finally {
      await fh.close().catch(() => undefined);
      await rm(tmp, { force: true });
    }
  }

  async replace(current: string, text: string) {
    // A symlinked fleet.conf stays a symlink: the file it points to is the one replaced.
    const path = await realpath(this.opts.confPath);
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
      if ((await readFile(path, "utf8")) !== current) throw new AdminError("conflict", "fleet.conf changed on the host during the save; nothing was written. Reload it and edit again");
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

  async restart(session: string, fleetSocket: string) {
    const env = { FLEET_CONF: this.opts.confPath };
    const tmux = this.opts.tmuxBin ?? "tmux";
    const socket = fleetSocket ? ["-L", fleetSocket] : [];
    // Ending a session that is not running is fine: the start below brings it up either way.
    const k = await run([tmux, ...socket, "kill-session", "-t", `=${session}`], { timeoutMs: 10_000 });
    if (k.exitCode !== 0 && !/can't find session|no server running|error connecting to/.test(k.stderr)) {
      return { ok: false, output: `tmux kill-session failed: ${k.stderr.trim()}` };
    }
    const s = await run([this.opts.fleetBin, "start", session], { env, timeoutMs: this.opts.restartTimeoutMs ?? 150_000 });
    return { ok: s.exitCode === 0, output: `${s.stdout}${s.stderr}` };
  }
}
