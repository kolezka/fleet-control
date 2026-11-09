// Isolated test fleet: private tmux socket, temp FLEET_DIR, one shell session with no model.
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveFleetBin } from "./path.ts";

export const defaultFleetBin = resolveFleetBin();

export type TestFleet = {
  dir: string;
  confPath: string;
  socket: string;
  session: string;
  tokens: string[];
  tmux(...args: string[]): Promise<{ exitCode: number; stdout: string }>;
  cleanup(): Promise<void>;
};

export async function createTestFleet(fleetBin = defaultFleetBin): Promise<TestFleet> {
  const dir = await mkdtemp(join(tmpdir(), "fleet-control-test-"));
  const name = `fctest${process.pid}${Math.floor(Math.random() * 1e6)}`;
  const socket = `fleet-${name}`;
  const session = "probe-shell";
  const tokens = [`FCTOKEN-${name}-alpha`, `FCTOKEN-${name}-beta`];
  await Bun.write(
    join(dir, "fleet.conf"),
    [
      `FLEET=${name}`,
      "REMOTE_SSH=",
      "REMOTE_USER=",
      `FLEET_DIR=${dir}`,
      `AGENT_CWD=${dir}`,
      `AGENTS=("${session}|Probe shell|probe.txt")`,
      "",
    ].join("\n"),
  );
  await copyFile(join(fleetBin, "..", "watchdog.sh"), join(dir, "watchdog.sh"));

  const tmux = async (...args: string[]) => {
    const p = Bun.spawn(["tmux", "-L", socket, "-f", "/dev/null", ...args], { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(p.stdout).text();
    return { exitCode: await p.exited, stdout };
  };
  const script = `printf '%s\\n' ${tokens.join(" ")}; exec sleep 3600`;
  const started = await tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "30", script);
  if (started.exitCode !== 0) throw new Error("could not start test tmux session");
  // wait until the tokens are on screen
  for (let i = 0; i < 50; i++) {
    const cap = await tmux("capture-pane", "-p", "-t", session);
    if (cap.stdout.includes(tokens[1]!)) break;
    await Bun.sleep(50);
  }

  return {
    dir,
    confPath: join(dir, "fleet.conf"),
    socket,
    session,
    tokens,
    tmux,
    async cleanup() {
      await tmux("kill-server");
      // tmux leaves the socket file behind; remove only our own, uniquely named one.
      const sock = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.()}`, socket);
      if (socket.startsWith("fleet-fctest")) await rm(sock, { force: true });
      if (dir.includes("fleet-control-test-")) await rm(dir, { recursive: true, force: true });
    },
  };
}
