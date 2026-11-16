// Sends one message file to a session through the existing `fleet send`. Its own guards stay in force.
import type { Sender } from "../domain/delivery.ts";
import { drainDeadline, readBounded } from "./bounded-read.ts";

const OUTPUT_LIMIT = 64 * 1024;
// fleet send waits for the pane itself (a few seconds at most). A run that takes longer has hung,
// for example on ssh; it is killed and the outcome stays unknown, never retried.
export const SEND_TIMEOUT_MS = 120_000;

// A stream cut at the drain deadline counts as complete: whatever the sender printed arrived before it exited.
async function captureOutput(stream: ReadableStream<Uint8Array>, until: Promise<void>): Promise<string | null> {
  const { bytes, overflow } = await readBounded(stream, OUTPUT_LIMIT, until, { keepDraining: true });
  if (overflow) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

type SpawnSender = (command: string[], options: { env: NodeJS.ProcessEnv; stdout: "pipe"; stderr: "pipe"; detached: true }) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; pid?: number };

export function fleetSender(fleetBin: string, confPath: string, spawn: SpawnSender = (command, options) => Bun.spawn(command, options), timeoutMs = SEND_TIMEOUT_MS): Sender {
  return async (session, file) => {
    // Own process group, so the kill also reaches tmux or ssh children that hold the pipes open.
    const p = spawn([fleetBin, "send", session, file], {
      env: { ...process.env, FLEET_CONF: confPath },
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    let timedOut = false;
    const drain = drainDeadline();
    const timer = setTimeout(() => {
      timedOut = true;
      if (p.pid !== undefined) try { process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ }
      drain.arm();
    }, timeoutMs);
    void p.exited.then(() => drain.arm(), () => drain.arm());
    const settled = await Promise.allSettled([captureOutput(p.stdout, drain.reached), captureOutput(p.stderr, drain.reached), p.exited]).finally(() => clearTimeout(timer));
    if (timedOut) return { exitCode: -1, stdout: "", stderr: "" };
    const [stdout, stderr, exitCode] = settled;
    // Never expose a valid-looking success prefix when either stream is incomplete or invalid.
    if (stdout.status !== "fulfilled" || stderr.status !== "fulfilled" || exitCode.status !== "fulfilled" || stdout.value === null || stderr.value === null) {
      return { exitCode: -1, stdout: "", stderr: "" };
    }
    return { exitCode: exitCode.value, stdout: stdout.value, stderr: stderr.value.trim() };
  };
}
