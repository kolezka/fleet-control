import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ReceiptOutbox } from "./outbox";
import type { HostReceipt } from "../domain/delivery.ts";

test("outer transactions decide whether returned enqueue and acknowledge changes persist", () => {
  const db = new Database(":memory:");
  try {
    const outbox = new ReceiptOutbox(db);
    const existing: HostReceipt = { hostId: "host", commandId: "existing", attemptId: "existing", status: "delivered" };
    const added: HostReceipt = { hostId: "host", commandId: "added", attemptId: "added", status: "unknown" };
    expect(outbox.enqueue(existing)).toEqual({ created: true });

    expect(() => db.transaction(() => {
      expect(outbox.enqueue(added)).toEqual({ created: true });
      expect(outbox.acknowledge(existing)).toBeUndefined();
      expect(outbox.pending()).toEqual([added]);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(outbox.pending()).toEqual([existing]);
    expect(() => outbox.acknowledge(added)).toThrow("receipt not found");

    db.transaction(() => {
      expect(outbox.enqueue(added)).toEqual({ created: true });
      expect(outbox.acknowledge(existing)).toBeUndefined();
      expect(outbox.pending()).toEqual([added]);
    })();
    expect(outbox.pending()).toEqual([added]);
    expect(outbox.enqueue(existing)).toEqual({ created: false });
    expect(outbox.pending()).toEqual([added]);
  } finally {
    db.close();
  }
});
