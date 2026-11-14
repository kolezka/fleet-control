import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DeliveryExecutor, type CommandOffer } from "./executor.ts";
import { DeliveryJournal } from "./data/journal.ts";

const base: CommandOffer = { id: "attempt", hostId: "host", target: "target", text: "text", instanceId: "instance" };
const fields = ["id", "hostId", "target", "text", "instanceId"] as const;

test("legacy malformed offer retry fails without altering its recorded attempt", async () => {
  const db = new Database(":memory:");
  try {
    const journal = new DeliveryJournal(db);
    const offer = { ...base, text: "legacy-\ud800" };
    const { createHash } = await import("node:crypto");
    const fingerprint = createHash("sha256").update(JSON.stringify([offer.id, offer.hostId, offer.target, offer.text, offer.instanceId])).digest("hex");
    journal.start(offer.id, fingerprint);
    journal.finish(offer.id, "unknown");
    let lookups = 0, sends = 0;
    const executor = new DeliveryExecutor(journal, "host", async () => { lookups++; return "instance"; }, async () => { sends++; return { exitCode: 0, stdout: "target: delivered", stderr: "" }; });
    await expect(executor.execute(offer)).rejects.toThrow("invalid offer encoding");
    expect(journal.get(offer.id)?.status).toBe("unknown");
    expect([lookups, sends]).toEqual([0, 0]);
  } finally { db.close(); }
});

for (const field of fields) {
  for (const [name, value] of [["high surrogate", "\ud800"], ["low surrogate", "\udc00"]] as const) {
    test("rejects lone " + name + " in " + field + " before lookup, send, or journal writes", async () => {
      const db = new Database(":memory:");
      try {
        const journal = new DeliveryJournal(db);
        const offer = { ...base, [field]: "prefix-" + value };
        let lookups = 0;
        let sends = 0;
        const executor = new DeliveryExecutor(journal, offer.hostId, async () => {
          lookups++;
          return offer.instanceId;
        }, async () => {
          sends++;
          return { exitCode: 0, stdout: offer.target + ": delivered", stderr: "" };
        });
        let error: unknown;
        try { await executor.execute(offer); } catch (caught) { error = caught; }
        expect({ rejected: error instanceof Error, lookups, sends, rows: db.query("SELECT * FROM host_delivery_attempts").all() }).toEqual({
          rejected: true, lookups: 0, sends: 0, rows: [],
        });
      } finally { db.close(); }
    });
  }

  for (const [name, value] of [["replacement character", "�"], ["emoji", "😀"]] as const) {
    test("accepts valid " + name + " in " + field, async () => {
      const db = new Database(":memory:");
      try {
        const journal = new DeliveryJournal(db);
        const offer = { ...base, [field]: "prefix-" + value };
        const lookedUp: string[] = [];
        const sent: CommandOffer[] = [];
        const executor = new DeliveryExecutor(journal, offer.hostId, async (target) => {
          lookedUp.push(target);
          return offer.instanceId;
        }, async (item) => {
          sent.push(item);
          return { exitCode: 0, stdout: offer.target + ": delivered", stderr: "" };
        });
        expect((await executor.execute(offer)).status).toBe("delivered");
        expect(lookedUp).toEqual([offer.target]);
        expect(sent).toEqual([offer]);
        expect(journal.get(offer.id)?.status).toBe("delivered");
        expect(db.query("SELECT id FROM host_delivery_attempts").all()).toEqual([{ id: offer.id }]);
      } finally { db.close(); }
    });
  }
}
