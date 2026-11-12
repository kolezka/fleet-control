// Delivers queued commands to the recipient session through the existing `fleet send`.
// fleet send's own guards (dialog open, someone typing, blank text, dialog-like text) stay in force.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, Commands } from "./commands.ts";

export type SendResult = { exitCode: number; stdout: string; stderr: string };
export type Sender = (session: string, file: string) => Promise<SendResult>;

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

// Exit 0 means delivered. "not sent" or "no session" on stderr means fleet send stopped before pasting, so a retry is safe.
// Anything else may have left text in the pane, so it is recorded as unknown and never retried by itself.
export function classify(r: SendResult): { status: "delivered" | "queued" | "delivery_unknown"; detail: string } {
  if (r.exitCode === 0 && /delivered/.test(r.stdout)) return { status: "delivered", detail: r.stdout };
  const detail = `fleet send exit ${r.exitCode}: ${r.stderr || r.stdout || "no output"}`;
  if (r.exitCode !== 0 && /not sent|^no session /m.test(r.stderr)) return { status: "queued", detail };
  return { status: "delivery_unknown", detail };
}

export class Deliverer {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private commands: Commands, private send: Sender) {}

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
    const dir = await mkdtemp(join(tmpdir(), "fleet-control-msg-"));
    try {
      const file = join(dir, `${c.id}.txt`);
      await Bun.write(file, messageFor(c));
      let result: SendResult;
      try {
        result = await this.send(c.target, file);
      } catch {
        return this.commands.transition(id, "delivery_unknown", "service", "fleet send failed with an exception");
      }
      const { status, detail } = classify(result);
      return this.commands.transition(id, status, "service", detail);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
