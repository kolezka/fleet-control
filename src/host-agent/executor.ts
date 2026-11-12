import { createHash } from "node:crypto";
import { classify, type SendResult } from "../delivery.ts";
import { DeliveryJournal, type DeliveryAttempt } from "./journal.ts";

export type CommandOffer = Readonly<{
  id: string;
  hostId: string;
  target: string;
  text: string;
  instanceId: string;
}>;

export class DeliveryExecutor {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private journal: DeliveryJournal,
    private hostId: string,
    private lookupInstance: (target: string) => Promise<string | null>,
    private send: (offer: CommandOffer) => Promise<SendResult>,
  ) {}

  async execute(offer: CommandOffer): Promise<DeliveryAttempt> {
    const intent = Object.freeze({ id: offer.id, hostId: offer.hostId, target: offer.target, text: offer.text, instanceId: offer.instanceId });
    if (intent.hostId !== this.hostId) throw new Error("offer host does not match local host");
    const result = this.queue.then(() => this.executeSerialized(intent));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async executeSerialized(intent: CommandOffer): Promise<DeliveryAttempt> {
    const fingerprint = createHash("sha256").update(JSON.stringify([intent.id, intent.hostId, intent.target, intent.text, intent.instanceId])).digest("hex");
    const existing = this.journal.findIntent(intent.id, fingerprint);
    if (existing) return existing;

    let instance: string | null;
    try {
      instance = await this.lookupInstance(intent.target);
    } catch (error) {
      const concurrent = this.journal.findIntent(intent.id, fingerprint);
      if (concurrent) return concurrent;
      throw error;
    }
    if (instance !== intent.instanceId) {
      const concurrent = this.journal.findIntent(intent.id, fingerprint);
      if (concurrent) return concurrent;
      throw new Error("offer runtime instance does not match local target");
    }

    const { authorized, attempt } = this.journal.start(intent.id, fingerprint);
    if (!authorized) return attempt;

    let status: "delivered" | "unknown" = "unknown";
    try {
      if (classify(await this.send(intent), intent.target).status === "delivered") status = "delivered";
    } catch {
      // A sender failure cannot prove whether delivery occurred.
    }
    return this.journal.finish(intent.id, status);
  }
}
