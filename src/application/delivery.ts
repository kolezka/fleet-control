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
