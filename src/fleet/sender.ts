// Sends one message file to a session through the existing `fleet send`. Its own guards stay in force.
import type { Sender } from "../domain/delivery.ts";

const OUTPUT_LIMIT = 64 * 1024;

async function captureOutput(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = stream.getReader();
  const bytes = new Uint8Array(OUTPUT_LIMIT);
  let length = 0;
  let overflow = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const retained = Math.min(value.byteLength, OUTPUT_LIMIT - length);
    bytes.set(value.subarray(0, retained), length);
    length += retained;
    if (retained < value.byteLength) overflow = true;
  }
  if (overflow) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } catch {
    return null;
  }
}

type SpawnSender = (command: string[], options: { env: NodeJS.ProcessEnv; stdout: "pipe"; stderr: "pipe" }) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> };

export function fleetSender(fleetBin: string, confPath: string, spawn: SpawnSender = (command, options) => Bun.spawn(command, options)): Sender {
  return async (session, file) => {
    const p = spawn([fleetBin, "send", session, file], {
      env: { ...process.env, FLEET_CONF: confPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.allSettled([captureOutput(p.stdout), captureOutput(p.stderr), p.exited]);
    // Never expose a valid-looking success prefix when either stream is incomplete or invalid.
    if (stdout.status !== "fulfilled" || stderr.status !== "fulfilled" || exitCode.status !== "fulfilled" || stdout.value === null || stderr.value === null) {
      return { exitCode: -1, stdout: "", stderr: "" };
    }
    return { exitCode: exitCode.value, stdout: stdout.value, stderr: stderr.value.trim() };
  };
}
