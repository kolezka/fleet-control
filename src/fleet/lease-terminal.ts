// Typing into a fleet session for an input lease. tmux refuses send-keys while a read-only client is
// attached (the page's own viewer is one), so bytes go in as a raw paste: load-buffer, then
// paste-buffer -d, the same path agent-fleet's watchdog uses. Where tmux has -S it is added, so control
// bytes such as Ctrl-C arrive raw instead of escaped.
import type { LeaseTerminal } from "../application/leases.ts";

export type Run = { exitCode: number; stdout: string; stderr: string };
// Session names must be this plain: it is what keeps them safe inside tmux's format filter below.
const PLAIN = /^[A-Za-z0-9._-]+$/;
const TIMEOUT_MS = 10_000;

async function run(argv: string[], stdin?: Uint8Array): Promise<Run> {
  const p = Bun.spawn(argv, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX: undefined } });
  const timer = setTimeout(() => p.kill("SIGKILL"), TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

// The fleet's own tmux socket, read from fleet.conf the way agent-fleet reads it. Local fleets only.
export async function fleetSocket(confPath: string): Promise<string> {
  const r = await run(["bash", "-c", '. "$0" >/dev/null 2>&1 || exit 3; printf "%s\\n%s\\n" "${FLEET_TMUX_SOCKET-fleet-$FLEET}" "${REMOTE_SSH:-}"', confPath]);
  if (r.exitCode !== 0) throw new Error("fleet.conf could not be read");
  const [socket = "", remote = ""] = r.stdout.split("\n");
  if (remote !== "") throw new Error("terminal input needs a local fleet (REMOTE_SSH is set)");
  if (socket !== "" && !PLAIN.test(socket)) throw new Error("FLEET_TMUX_SOCKET is not a plain name");
  return socket;
}

// tmux path: the service's PATH may lack Homebrew, so look in the usual places too.
export function findTmux(path = process.env.PATH ?? ""): string {
  const found = Bun.which("tmux", { PATH: [path, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].join(":") });
  if (!found) throw new Error("tmux not found on PATH, /opt/homebrew/bin, /usr/local/bin or /usr/bin");
  return found;
}

// `runner` is replaceable for tests that stand in for tmux.
export function tmuxLeaseTerminal(socket: string, tmuxBin = findTmux(), runner: (argv: string[], stdin?: Uint8Array) => Promise<Run> = run, psBin = "/bin/ps"): LeaseTerminal {
  const tmux = (...args: string[]) => [tmuxBin, ...(socket ? ["-L", socket, "-f", "/dev/null"] : []), ...args];
  // "=name:" matches the session name exactly, never a prefix of another session.
  const target = (session: string) => {
    if (!PLAIN.test(session)) throw new Error("bad session name");
    return `=${session}:`;
  };
  // Newer tmux escapes control bytes in a paste unless given -S; older tmux has no -S and does not escape.
  let raw: Promise<string[]> | undefined;
  // Asked once; a probe that failed is asked again next time instead of failing every later paste.
  const pasteRaw = () => (raw ??= runner([tmuxBin, "list-commands", "paste-buffer"]).then(
    (r) => (r.exitCode === 0 && /-[a-zA-Z]*S/.test(r.stdout) ? ["-S"] : []),
    (e) => { raw = undefined; throw e; },
  ));
  return {
    // The session's id, creation time and the pid of its active pane, then "shell" or "app": "shell" when the
    // pane's own first process holds the terminal's foreground (a shell at its prompt), "app" when something
    // it started does (the agent, also behind a wrapper script). agent-fleet starts every agent, also a
    // restart, in a new window, so a restarted agent has a new pane pid. A command typed into the same pane
    // does not change it; an agent that exits leaves the pane at the prompt, which ends the lease.
    async instance(session) {
      target(session);
      // The filter matches the name whole (tmux prints a tab as "_", so names are not parsed from the output).
      const r = await runner(tmux("list-sessions", "-f", `#{==:#{session_name},${session}}`, "-F", "#{session_id}:#{session_created}:#{pane_pid}"));
      // No server at all means no session; anything else that failed means tmux could not be asked.
      if (r.exitCode !== 0) {
        if (/no server running|error connecting to/.test(r.stderr)) return null;
        throw new Error(`tmux could not be asked: ${r.stderr.trim().slice(0, 200) || `exit ${r.exitCode}`}`);
      }
      const lines = r.stdout.split("\n").filter((l) => l !== "");
      if (lines.length === 0) return null;
      const m = lines.length === 1 ? /^\$\d+:\d+:(\d+)$/.exec(lines[0]!) : null;
      if (!m) throw new Error(`tmux could not describe ${session}: ${lines.join(" ").slice(0, 80)}`);
      // The terminal's foreground process group, as seen from the pane's first process.
      const fg = await runner([psBin, "-o", "tpgid=", "-p", m[1]!]);
      const tpgid = fg.stdout.trim();
      if (fg.exitCode !== 0 || !/^-?\d+$/.test(tpgid)) throw new Error(`could not read the foreground of ${session}'s pane ${m[1]}`);
      return `${lines[0]}:${tpgid === m[1] ? "shell" : "app"}`;
    },
    async type(session, bytes) {
      const buffer = `fcinput-${process.pid}-${crypto.randomUUID()}`;
      const r = await runner(tmux("load-buffer", "-b", buffer, "-", ";", "paste-buffer", ...(await pasteRaw()), "-d", "-b", buffer, "-t", target(session)), bytes);
      if (r.exitCode !== 0) {
        await runner(tmux("delete-buffer", "-b", buffer));
        throw new Error(`tmux refused the input: ${r.stderr.trim().slice(0, 200) || `exit ${r.exitCode}`}`);
      }
    },
  };
}
