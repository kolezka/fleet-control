// agent-fleet's watchdog as a launchd agent (macOS) or a systemd user unit (Linux), one per fleet.
// The service runs `watchdog.sh --quiet-start` from FLEET_DIR with a bash 4+, the way `fleet watchdog start` does in tmux.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdminError } from "../domain/fleet-admin.ts";
import { watchdogName, type WatchdogState } from "../domain/watchdog.ts";
import type { WatchdogFleet, WatchdogHost } from "../application/watchdog.ts";

type Run = { exitCode: number; stdout: string; stderr: string };
async function run(argv: string[], timeoutMs = 15_000): Promise<Run> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX: undefined } });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

// watchdog.sh needs bash 4+; stock macOS has 3.2 at /bin/bash.
export async function findBash(candidates = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"]): Promise<string | null> {
  for (const b of candidates) {
    if (!(await Bun.file(b).exists())) continue;
    const r = await run([b, "-c", "echo ${BASH_VERSINFO[0]}"]).catch(() => null);
    if (r && r.exitCode === 0 && Number(r.stdout.trim()) >= 4) return b;
  }
  return null;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// systemd unit values: quote words with spaces, double % and backslashes.
// In ExecStart systemd also expands $VAR, so $ is doubled there.
const unitWord = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
const execWord = (s: string) => unitWord(s).replace(/\$/g, "$$$$");
const LOG = "watchdog.service.log";

export function launchdPlist(label: string, f: WatchdogFleet, bash: string, path: string): string {
  // caffeinate keeps the Mac awake while the watchdog runs, as `fleet watchdog start` does.
  const args = ["/usr/bin/caffeinate", "-i", bash, join(f.dir, "watchdog.sh"), "--quiet-start"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(f.dir)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <!-- tmux servers the watchdog starts must outlive a stop of the watchdog. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${xml(join(f.dir, LOG))}</string>
  <key>StandardErrorPath</key><string>${xml(join(f.dir, LOG))}</string>
</dict>
</plist>
`;
}

export function systemdUnit(f: WatchdogFleet, bash: string, path: string): string {
  if (/[\x00-\x1f\x7f]/.test(f.dir + path)) throw new AdminError("invalid", "FLEET_DIR or PATH has control characters");
  return `[Unit]
Description=agent-fleet watchdog for fleet ${f.fleet} (set up by Fleet Control)

[Service]
WorkingDirectory=${f.dir.replace(/%/g, "%%")}
Environment=${unitWord(`PATH=${path}`)}
ExecStart=${execWord(bash)} ${execWord(join(f.dir, "watchdog.sh"))} --quiet-start
Restart=on-failure
RestartSec=30
# Only the watchdog itself stops: tmux servers and agents it started keep running.
KillMode=process
StandardOutput=append:${join(f.dir, LOG).replace(/%/g, "%%")}
StandardError=append:${join(f.dir, LOG).replace(/%/g, "%%")}

[Install]
WantedBy=default.target
`;
}

export type WatchdogServiceOpts = {
  manager: "launchd" | "systemd" | null;
  home: string;
  uid: number;
  bash: string | null;
  // PATH the watchdog runs with: tmux, rg, claude, node and dsh must be on it.
  path: string;
  tmuxBin?: string;
  launchctl?: string;
  systemctl?: string;
  // How long a fresh start must keep running before it counts as started.
  settleMs?: number;
};

export class WatchdogService implements WatchdogHost {
  constructor(readonly opts: WatchdogServiceOpts) {}

  private file(name: string) {
    return this.opts.manager === "launchd" ? join(this.opts.home, "Library", "LaunchAgents", `${name}.plist`) : join(this.opts.home, ".config", "systemd", "user", name);
  }
  private launchctl(...a: string[]) { return run([this.opts.launchctl ?? "launchctl", ...a]); }
  private systemctl(...a: string[]) { return run([this.opts.systemctl ?? "systemctl", "--user", ...a]); }

  private async inTmux(f: WatchdogFleet): Promise<{ inTmux: boolean | null; inTmuxError?: string }> {
    const tmux = this.opts.tmuxBin ?? "tmux";
    const r = await run([tmux, ...(f.socket ? ["-L", f.socket, "-f", "/dev/null"] : []), "has-session", "-t", `=${f.fleet}-watchdog`], 3_000);
    if (r.exitCode === 0) return { inTmux: true };
    // Only a plain "not there" counts as no watchdog (no session, no socket, nothing listening); any other tmux
    // error leaves it unknown, and unknown never lets a second watchdog start.
    if (/can't find session|no server running|error connecting to .*\((No such file or directory|Connection refused)\)/i.test(r.stderr)) return { inTmux: false };
    // One line, short: it is shown on the page as is.
    const first = r.stderr.trim().split("\n")[0]!.slice(0, 200);
    return { inTmux: null, inTmuxError: first || `tmux exited ${r.exitCode}` };
  }

  private async pid(name: string): Promise<number | null> {
    if (this.opts.manager === "launchd") {
      const r = await this.launchctl("print", `gui/${this.opts.uid}/${name}`);
      // launchd's top-level "\tpid = N" line, not a nested block's.
      const m = r.exitCode === 0 ? /^\tpid = (\d+)$/m.exec(r.stdout) : null;
      return m ? Number(m[1]) : null;
    }
    const r = await this.systemctl("show", "-p", "MainPID", "--value", name);
    const n = Number(r.stdout.trim());
    return r.exitCode === 0 && n > 0 ? n : null;
  }

  async state(f: WatchdogFleet): Promise<WatchdogState> {
    const tmux = await this.inTmux(f);
    if (!this.opts.manager) return { manager: null, name: "", installed: false, running: false, pid: null, ...tmux };
    const name = watchdogName(this.opts.manager, f.fleet);
    const installed = await Bun.file(this.file(name)).exists();
    const pid = await this.pid(name);
    return { manager: this.opts.manager, name, installed, running: pid !== null, pid, ...tmux };
  }

  private async loaded(name: string) {
    return (await this.launchctl("print", `gui/${this.opts.uid}/${name}`)).exitCode === 0;
  }

  private async lastLog(f: WatchdogFleet) {
    const t = await readFile(join(f.dir, LOG), "utf8").catch(() => "");
    return t.trim().split("\n").slice(-3).join(" ") || "no output";
  }

  async start(f: WatchdogFleet): Promise<void> {
    const manager = this.opts.manager!;
    if (!this.opts.bash) throw new AdminError("failed", "no bash 4 or newer on this host; the watchdog needs it (on macOS: brew install bash)");
    if (!(await Bun.file(join(f.dir, "watchdog.sh")).exists())) throw new AdminError("failed", `${join(f.dir, "watchdog.sh")} is missing; run fleet sync first`);
    const name = watchdogName(manager, f.fleet);
    const file = this.file(name);
    await mkdir(join(file, ".."), { recursive: true });
    try {
      if (manager === "launchd") {
        // A job still loaded (exited, or loaded by hand) keeps its old definition: unload it first, and wait
        // until launchd has let go, or the bootstrap fails with 5.
        if (await this.loaded(name)) {
          await this.launchctl("bootout", `gui/${this.opts.uid}/${name}`);
          for (let i = 0; i < 50 && await this.loaded(name); i++) await Bun.sleep(100);
        }
        await writeFile(file, launchdPlist(name, f, this.opts.bash, this.opts.path), { mode: 0o644 });
        // 5 is also launchd's error for a plist it refuses; such a refusal reaches the page after the retries (about 7.5 s).
        let r = await this.launchctl("bootstrap", `gui/${this.opts.uid}`, file);
        for (let i = 0; r.exitCode !== 0 && /: (5|37):/.test(r.stderr) && i < 4; i++) {
          await Bun.sleep(500 * 2 ** i);
          r = await this.launchctl("bootstrap", `gui/${this.opts.uid}`, file);
        }
        if (r.exitCode !== 0) throw new AdminError("failed", `launchctl could not start ${name}: ${r.stderr.trim()}`);
      } else {
        await writeFile(file, systemdUnit(f, this.opts.bash, this.opts.path), { mode: 0o644 });
        const d = await this.systemctl("daemon-reload");
        if (d.exitCode !== 0) throw new AdminError("failed", `systemctl daemon-reload failed: ${d.stderr.trim()}`);
        const r = await this.systemctl("enable", "--now", name);
        if (r.exitCode !== 0) throw new AdminError("failed", `systemctl could not start ${name}: ${r.stderr.trim()}`);
      }
    } catch (e) {
      // A file left behind would read as installed but off.
      await this.stop(f).catch(() => undefined);
      throw e;
    }
    // A watchdog that cannot load fleet.conf or finds an old bash exits at once.
    await Bun.sleep(this.opts.settleMs ?? 2_000);
    const pid = await this.pid(name);
    if (pid === null) {
      const why = await this.lastLog(f);
      await this.stop(f).catch(() => undefined);
      throw new AdminError("failed", `the watchdog did not keep running: ${why}`);
    }
  }

  async stop(f: WatchdogFleet): Promise<void> {
    const manager = this.opts.manager!;
    const name = watchdogName(manager, f.fleet);
    const file = this.file(name);
    if (manager === "launchd") {
      const r = await this.launchctl("bootout", `gui/${this.opts.uid}/${name}`);
      if (r.exitCode !== 0 && !/No such process|Could not find|not find service/i.test(r.stderr + r.stdout)) {
        throw new AdminError("failed", `launchctl could not stop ${name}: ${r.stderr.trim()}`);
      }
      await rm(file, { force: true });
    } else {
      if (await Bun.file(file).exists()) {
        const r = await this.systemctl("disable", "--now", name);
        if (r.exitCode !== 0) throw new AdminError("failed", `systemctl could not stop ${name}: ${r.stderr.trim()}`);
      }
      await rm(file, { force: true });
      await this.systemctl("daemon-reload");
    }
    if ((await this.pid(name)) !== null) throw new AdminError("failed", `${name} still runs after the stop`);
  }
}

export function managerOf(platform: NodeJS.Platform, env: Record<string, string | undefined>): "launchd" | "systemd" | null {
  if (platform === "darwin") return "launchd";
  // A user systemd answers on XDG_RUNTIME_DIR; a container or a plain shell has none.
  if (platform === "linux" && env.XDG_RUNTIME_DIR) return "systemd";
  return null;
}
