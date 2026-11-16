// Thin adapter over the existing agent-fleet CLI. It never talks to tmux or SSH itself.
import { FleetError, type FleetSessionStatus, type FleetStatus, type FleetReader } from "../domain/fleet.ts";
import { drainDeadline, readBounded } from "./bounded-read.ts";

const sessionName = /^[A-Za-z0-9._-]+$/;

type RunResult = { exitCode: number; stdout: string; stderr: string };

// A hung CLI (for example ssh to a remote host that stopped answering) must not hold a request and
// its process forever, and a runaway one must not fill memory.
export const CLI_TIMEOUT_MS = 20_000;
export const CLI_OUTPUT_LIMIT = 8 * 1024 * 1024;

export class FleetCli implements FleetReader {
  constructor(
    readonly options: { fleetBin: string; confPath: string; env?: Record<string, string | undefined>; timeoutMs?: number; outputLimit?: number },
  ) {}

  private async run(args: string[]): Promise<RunResult> {
    const timeoutMs = this.options.timeoutMs ?? CLI_TIMEOUT_MS;
    const limit = this.options.outputLimit ?? CLI_OUTPUT_LIMIT;
    const proc = Bun.spawn([this.options.fleetBin, ...args], {
      env: { ...process.env, ...this.options.env, FLEET_CONF: this.options.confPath },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // Own process group, so a kill also reaches children (ssh, tmux) that hold the pipes open.
      detached: true,
    });
    let stopped: "timed out" | "output too large" | null = null;
    const drain = drainDeadline();
    const stop = (why: "timed out" | "output too large") => {
      stopped ??= why;
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
      drain.arm();
    };
    const timer = setTimeout(() => stop("timed out"), timeoutMs);
    void proc.exited.then(() => drain.arm());
    try {
      const onOverflow = () => stop("output too large");
      const [out, err, exitCode] = await Promise.all([
        readBounded(proc.stdout, limit, drain.reached, { onOverflow }),
        readBounded(proc.stderr, limit, drain.reached, { onOverflow }),
        proc.exited,
      ]);
      if (stopped) throw new FleetError("cli_failed", `fleet ${args[0]} ${stopped}; process killed`, { exitCode });
      const text = (b: Uint8Array) => new TextDecoder().decode(b);
      return { exitCode, stdout: text(out.bytes), stderr: text(err.bytes) };
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(result: RunResult, what: string): never {
    if (/fleet\.conf not found|missing in fleet\.conf|cannot read FLEET_DIR/.test(result.stderr)) {
      throw new FleetError("config", `fleet ${what}: configuration error`, result);
    }
    throw new FleetError("cli_failed", `fleet ${what} exited ${result.exitCode}`, result);
  }

  async screen(session: string, lines = 40): Promise<string> {
    if (!sessionName.test(session)) throw new FleetError("invalid_name", `invalid session name: ${session}`);
    if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) {
      throw new FleetError("invalid_name", `invalid line count: ${lines}`);
    }
    const result = await this.run(["screen", session, String(lines)]);
    if (result.exitCode !== 0) this.fail(result, "screen");
    // agent-fleet 0.3.0 pipes capture-pane through awk/tail, so a missing pane still exits 0.
    if (/can't find (pane|session|window)/.test(result.stderr)) {
      throw new FleetError("session_missing", `session not found: ${session}`, result);
    }
    return result.stdout;
  }

  async status(): Promise<FleetStatus> {
    const result = await this.run(["status"]);
    if (result.exitCode !== 0) this.fail(result, "status");
    return parseStatus(result.stdout);
  }
}

// Parses agent-fleet 0.3.0 `fleet status` text. Unknown shapes fail instead of becoming an empty fleet.
export function parseStatus(raw: string): FleetStatus {
  const lines = raw.split("\n");
  const logAt = lines.indexOf("--- last state per agent (watchdog.log)");
  const ctxAt = lines.indexOf("--- context");
  if (logAt < 0 || ctxAt < logAt) throw new FleetError("malformed_output", "fleet status: section markers missing");

  const running = new Set<string>();
  for (const line of lines.slice(0, logAt)) {
    if (line === "no fleet tmux sessions" || line === "") continue;
    const m = /^([A-Za-z0-9._-]+): \d+ windows? /.exec(line);
    if (!m) throw new FleetError("malformed_output", `fleet status: unexpected tmux line: ${line}`);
    running.add(m[1]!);
  }

  const sessions: FleetSessionStatus[] = [];
  for (const line of lines.slice(ctxAt + 1)) {
    if (line === "") continue;
    const m = /^([A-Za-z0-9._-]+) ctx=(\d+|\?)%$/.exec(line);
    if (!m) throw new FleetError("malformed_output", `fleet status: unexpected context line: ${line}`);
    sessions.push({ name: m[1]!, running: running.has(m[1]!), contextPct: m[2] === "?" ? null : Number(m[2]) });
  }
  return { sessions, raw };
}
