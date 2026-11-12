// Delivers queued commands to the recipient session through the existing `fleet send`.
// fleet send's own guards (dialog open, someone typing, blank text, dialog-like text) stay in force.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, Commands } from "./commands.ts";

export type SendResult = { exitCode: number; stdout: string; stderr: string };
export type Sender = (session: string, file: string) => Promise<SendResult>;

type DeliveryIO = {
  mkdtemp: (prefix: string) => Promise<string>;
  write: (file: string, contents: string) => Promise<unknown>;
  rm: (dir: string) => Promise<void>;
};

const defaultIO: DeliveryIO = {
  mkdtemp,
  write: (file, contents) => Bun.write(file, contents),
  rm: (dir) => rm(dir, { recursive: true, force: true }),
};

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

// The bundled sender probes only the first 40 characters, not the full command ID.
export function messageFor(c: Command): string {
  // Backslashes are doubled so literal escape text cannot collide with escaped controls.
  // Actors without backslashes or listed controls are unchanged; other Unicode is not sanitized.
  const actor = c.actor.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) => character === "\\" ? "\\\\" : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return [
    `Fleet Control command ${c.id} from ${actor}:`,
    "",
    c.text,
    "",
    `This message is a delivery, not an approval. Accept or reject ${c.id} with the fleet-control command_respond tool before acting on it.`,
    "",
  ].join("\n");
}

// Sender output cannot prove no effect. Unconfirmed results are unknown and never retried automatically.
export function classify(r: SendResult, target: string): { status: "delivered" | "delivery_unknown"; detail: string } {
  const expected = `${target}: delivered`;
  if (r.exitCode === 0 && (r.stdout === expected || r.stdout === `${expected}\n` || r.stdout === `${expected}\r\n`)) return { status: "delivered", detail: r.stdout };
  return { status: "delivery_unknown", detail: "fleet send result unknown" };
}

export class Deliverer {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private commands: Commands, private send: Sender, private io: DeliveryIO = defaultIO) {}

  // This queue serializes only this instance, not other processes or senders.
  deliver(id: string): Promise<Command> {
    const run = this.chain.then(() => this.deliverNow(id));
    this.chain = run.catch(() => {});
    return run;
  }

  private async deliverNow(id: string): Promise<Command> {
    const c = this.commands.get(id);
    if (c.status !== "queued") return c;
    this.commands.transition(id, "delivering", "service", `fleet send to ${c.target}`);
    let dir: string;
    try {
      dir = await this.io.mkdtemp(join(tmpdir(), "fleet-control-msg-"));
    } catch {
      return this.commands.transition(id, "delivery_unknown", "service", "delivery setup failed");
    }
    try {
      const file = join(dir, `${c.id}.txt`);
      try {
        await this.io.write(file, messageFor(c));
      } catch {
        return this.commands.transition(id, "delivery_unknown", "service", "delivery setup failed");
      }
      let result: SendResult;
      try {
        result = await this.send(c.target, file);
      } catch {
        return this.commands.transition(id, "delivery_unknown", "service", "fleet send failed with an exception");
      }
      const { status, detail } = classify(result, c.target);
      return this.commands.transition(id, status, "service", detail);
    } finally {
      try {
        await this.io.rm(dir);
      } catch {
        try {
          console.warn("Delivery cleanup failed");
        } catch {
          // A broken logger must not replace the delivery outcome.
        }
      }
    }
  }
}
