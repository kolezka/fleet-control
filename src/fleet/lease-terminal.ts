// Typing into a fleet session for an input lease. tmux refuses send-keys while a read-only client is
// attached (the page's own viewer is one), so bytes go in as a raw paste: load-buffer, then
// paste-buffer -d, the same path agent-fleet's watchdog uses. Where tmux has -S it is added, so control
// bytes such as Ctrl-C arrive raw instead of escaped.
import type { LeaseTerminal } from "../application/leases.ts";

export type Run = { exitCode: number; stdout: string; stderr: string };
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

// `runner` is replaceable for tests that stand in for tmux and pgrep.
export function tmuxLeaseTerminal(socket: string, tmuxBin = findTmux(), runner: (argv: string[], stdin?: Uint8Array) => Promise<Run> = run, pgrepBin = Bun.which("pgrep") ?? "/usr/bin/pgrep"): LeaseTerminal {
  const tmux = (...args: string[]) => [tmuxBin, ...(socket ? ["-L", socket, "-f", "/dev/null"] : []), ...args];
  // "=name:" matches the session name exactly, never a prefix of another session.
  const target = (session: string) => {
    if (!PLAIN.test(session)) throw new Error("bad session name");
    return `=${session}:`;
  };
  // Newer tmux escapes control bytes in a paste unless given -S; older tmux has no -S and does not escape.
  let raw: Promise<string[]> | undefined;
  const pasteRaw = () => (raw ??= runner([tmuxBin, "list-commands", "paste-buffer"]).then((r) => (r.exitCode === 0 && /-[a-zA-Z]*S/.test(r.stdout) ? ["-S"] : [])));
  return {
    async instance(session) {
      const t = target(session);
      const r = await runner(tmux("list-sessions", "-F", "#{session_name}"));
      // No server at all means no session; anything else that failed means tmux could not be asked.
      if (r.exitCode !== 0) {
        if (/no server running|error connecting to/.test(r.stderr)) return null;
        throw new Error(`tmux could not be asked: ${r.stderr.trim().slice(0, 200) || `exit ${r.exitCode}`}`);
      }
      if (!r.stdout.split("\n").includes(session)) return null;
      const d = await runner(tmux("display-message", "-p", "-t", t, "#{session_id}:#{session_created}:#{pane_pid}"));
      const v = d.stdout.trim();
      if (d.exitCode !== 0 || !/^\$\d+:\d+:\d+$/.test(v)) throw new Error(`tmux could not describe ${session}: ${d.stderr.trim().slice(0, 200) || v.slice(0, 80)}`);
      // agent-fleet types the agent command into the pane's shell, so the pane pid outlives an agent
      // restart in that pane. The oldest child of the shell is the program running there now.
      const pane = v.split(":")[2]!;
      const c = await runner([pgrepBin, "-o", "-P", pane]);
      const child = c.exitCode === 0 ? c.stdout.trim() : c.exitCode === 1 ? "-" : null;
      if (child === null || (child !== "-" && !/^\d+$/.test(child))) throw new Error(`pgrep failed for pane ${pane}`);
      return `${v}:${child}`;
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
