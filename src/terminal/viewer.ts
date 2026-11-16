// Read-only terminal viewer: a host PTY running `fleet attach --read-only <session>`.
// It has no write path on purpose; tmux also drops keys and ignores the viewer size.
import { FleetError } from "../domain/fleet.ts";
import { runProbe } from "../observe/claude.ts";

const sessionName = /^[A-Za-z0-9._-]+$/;

// No resize either: as the only tmux client, a resized viewer would resize the agent's window.
export type Viewer = {
  // Ends the viewer only: the tmux client detaches, the session keeps running.
  close(): void;
  exited: Promise<number>;
};

// Runs on every viewer open, so it is bounded like the other probes; a hung or failed check refuses.
export async function supportsReadOnlyAttach(fleetBin: string, timeoutMs?: number): Promise<boolean> {
  // Help may go to either stream; sh merges them so one bounded read sees both.
  const { out } = await runProbe(["/bin/sh", "-c", 'exec "$0" help 2>&1', fleetBin], { timeoutMs, outputLimit: 256 * 1024 });
  return out.includes("fleet attach [--read-only]");
}

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  const c = cols as number;
  const r = rows as number;
  if (c < 10 || c > 500 || r < 5 || r > 200) return null;
  return { cols: c, rows: r };
}

export async function openViewer(opts: {
  fleetBin: string;
  confPath: string;
  session: string;
  cols: number;
  rows: number;
  onData(data: Uint8Array): void;
  onExit(code: number): void;
}): Promise<Viewer> {
  if (!sessionName.test(opts.session)) throw new FleetError("invalid_name", `invalid session name: ${opts.session}`);
  const readOnly = await supportsReadOnlyAttach(opts.fleetBin).catch(() => {
    throw new FleetError("cli_failed", "fleet help did not answer; refusing to attach");
  });
  if (!readOnly) {
    throw new FleetError("cli_failed", "this agent-fleet CLI has no `attach --read-only`; refusing a writable attach");
  }
  const proc = Bun.spawn([opts.fleetBin, "attach", "--read-only", opts.session], {
    env: { ...process.env, FLEET_CONF: opts.confPath, TERM: "xterm-256color", TMUX: undefined },
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      data: (_t, data) => opts.onData(data),
    },
  });
  const exited = proc.exited.then((code) => {
    opts.onExit(code);
    return code;
  });
  return {
    close() {
      proc.kill("SIGHUP");
    },
    exited,
  };
}
