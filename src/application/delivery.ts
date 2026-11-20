// Delivers one queued command to its recipient session and records the outcome.
// The sender is injected; the bundled one is `fleetSender` in src/fleet/sender.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Commands } from "../data/commands.ts";
import type { Command } from "../domain/commands.ts";
import { type SendResult, type Sender, messageFor, classify } from "../domain/delivery.ts";

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

export class Deliverer {
  private chain: Promise<unknown> = Promise.resolve();

  // `held` says whether a session has a live input lease. A queued command for it then stays queued,
  // so a paste never lands in the middle of what a person is typing; `deliverQueued` sends it later.
  constructor(private commands: Commands, private send: Sender, private io: DeliveryIO = defaultIO, private held: (session: string) => Promise<boolean> = async () => false) {}

  // Sends every queued command for one session, oldest first. Called when its input lease ends.
  async deliverQueued(session: string): Promise<Command[]> {
    const out: Command[] = [];
    // One failed delivery must not strand the commands queued behind it.
    for (const c of this.commands.list("queued")) {
      if (c.target !== session) continue;
      try { out.push(await this.deliver(c.id)); } catch (e) { console.error(`delivery of ${c.id} failed: ${e instanceof Error ? e.message : e}`); }
    }
    return out;
  }

  // This queue serializes only this instance, not other processes or senders.
  deliver(id: string): Promise<Command> {
    const run = this.chain.then(() => this.deliverNow(id));
    this.chain = run.catch(() => {});
    return run;
  }

  private async deliverNow(id: string): Promise<Command> {
    const c = this.commands.get(id);
    if (c.status !== "queued") return c;
    if (await this.held(c.target)) return c;
    this.commands.transition(id, "delivering", "service", `fleet send to ${c.target}`);
    let dir: string;
    try {
      dir = await this.io.mkdtemp(join(tmpdir(), "fleet-control-msg-"));
    } catch {
      return this.commands.deliveryOutcome(id, "delivery_unknown", "delivery setup failed");
    }
    try {
      const file = join(dir, `${c.id}.txt`);
      try {
        await this.io.write(file, messageFor(c));
      } catch {
        return this.commands.deliveryOutcome(id, "delivery_unknown", "delivery setup failed");
      }
      let result: SendResult;
      try {
        result = await this.send(c.target, file);
      } catch {
        return this.commands.deliveryOutcome(id, "delivery_unknown", "fleet send failed with an exception");
      }
      const { status, detail } = classify(result, c.target);
      // The recipient may have answered already; then the answer stays and this is recorded beside it.
      return this.commands.deliveryOutcome(id, status, detail);
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
