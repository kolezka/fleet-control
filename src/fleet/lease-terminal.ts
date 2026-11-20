// Typing into a fleet session for an input lease. tmux refuses send-keys while a read-only client is
// attached (the page's own viewer is one), so bytes go in as a raw paste: load-buffer, then
// paste-buffer -S -d, the same path agent-fleet's watchdog uses. -S keeps control bytes such as Ctrl-C.
import type { LeaseTerminal } from "../application/leases.ts";

type Run = { exitCode: number; stdout: string; stderr: string };
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

export function tmuxLeaseTerminal(socket: string, tmuxBin = "tmux"): LeaseTerminal {
  const tmux = (...args: string[]) => [tmuxBin, ...(socket ? ["-L", socket, "-f", "/dev/null"] : []), ...args];
  // "=name:" matches the session name exactly, never a prefix of another session.
  const target = (session: string) => {
    if (!PLAIN.test(session)) throw new Error("bad session name");
    return `=${session}:`;
  };
  return {
    async instance(session) {
      const r = await run(tmux("display-message", "-p", "-t", target(session), "#{session_id}:#{session_created}:#{pane_pid}"));
      const v = r.stdout.trim();
      return r.exitCode === 0 && /^\$\d+:\d+:\d+$/.test(v) ? v : null;
    },
    async type(session, bytes) {
      const buffer = `fcinput-${process.pid}-${crypto.randomUUID()}`;
      const r = await run(tmux("load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-S", "-d", "-b", buffer, "-t", target(session)), bytes);
      if (r.exitCode !== 0) {
        await run(tmux("delete-buffer", "-b", buffer));
        throw new Error(`tmux refused the input: ${r.stderr.trim().slice(0, 200) || `exit ${r.exitCode}`}`);
      }
    },
  };
}
