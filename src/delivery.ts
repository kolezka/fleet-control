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

export function fleetSender(fleetBin: string, confPath: string): Sender {
  return async (session, file) => {
    const p = Bun.spawn([fleetBin, "send", session, file], {
      env: { ...process.env, FLEET_CONF: confPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  };
}

// The first line carries the command id, so fleet send's "first line appeared" check is specific to it.
export function messageFor(c: Command): string {
  return [
    `Fleet Control command ${c.id} from ${c.actor}:`,
    "",
    c.text,
    "",
    `This message is a delivery, not an approval. Accept or reject ${c.id} with the fleet-control command_respond tool before acting on it.`,
    "",
  ].join("\n");
}

// Sender output cannot prove no effect. Unconfirmed results are unknown and never retried automatically.
export function classify(r: SendResult): { status: "delivered" | "delivery_unknown"; detail: string } {
  if (r.exitCode === 0 && /delivered/.test(r.stdout)) return { status: "delivered", detail: r.stdout };
  const detail = `fleet send exit ${r.exitCode}: ${r.stderr || r.stdout || "no output"}`;
  return { status: "delivery_unknown", detail };
}

export class Deliverer {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private commands: Commands, private send: Sender, private io: DeliveryIO = defaultIO) {}

  // One delivery at a time per service, so two pastes never interleave in one pane.
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
      const { status, detail } = classify(result);
      return this.commands.transition(id, status, "service", detail);
    } finally {
      // Cleanup can fail and mask the result; a crash or failed mkdtemp can leave files behind.
      await this.io.rm(dir);
    }
  }
}
