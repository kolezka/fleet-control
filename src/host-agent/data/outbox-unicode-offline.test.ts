import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OutboxError, ReceiptOutbox } from "./outbox";
import type { HostReceipt } from "../domain/delivery.ts";

const replacement: HostReceipt = { hostId: "host-�", commandId: "command-�", attemptId: "attempt-�", status: "delivered" };
const emoji: HostReceipt = { hostId: "host-😀", commandId: "command-😀", attemptId: "attempt-😀", status: "unknown" };

for (const field of ["hostId", "commandId", "attemptId"] as const) {
  for (const surrogate of ["\ud800", "\udc00"]) {
    for (const operation of ["enqueue", "acknowledge"] as const) {
      test("rejects " + surrogate.charCodeAt(0).toString(16) + " in " + field + " during " + operation + " without mutating rows", () => {
        const db = new Database(":memory:");
        try {
          const outbox = new ReceiptOutbox(db);
          outbox.enqueue(replacement);
          outbox.enqueue(emoji);
          const rows = () => db.query("SELECT attempt_id, host_id, command_id, status, acknowledged FROM host_receipt_outbox ORDER BY rowid").all();
          const before = rows();
          const invalid = { ...replacement, [field]: replacement[field].replace("�", surrogate) };
          let error: unknown;
          try { outbox[operation](invalid); } catch (caught) { error = caught; }
          expect(rows()).toEqual(before);
          expect(outbox.pending()).toEqual([replacement, emoji]);
          expect(error).toBeInstanceOf(OutboxError);
          expect((error as OutboxError).kind).toBe("invalid");
        } finally { db.close(); }
      });
    }
  }
}

test("enqueue and acknowledge snapshot receipt fields once", () => {
  const db = new Database(":memory:");
  try {
    const outbox = new ReceiptOutbox(db);
    const makeReceipt = () => {
      const counts = { hostId: 0, commandId: 0, attemptId: 0, status: 0 };
      const value = {
        get hostId() { return ++counts.hostId === 1 ? "host" : "other"; },
        get commandId() { return ++counts.commandId === 1 ? "command" : "other"; },
        get attemptId() { return ++counts.attemptId === 1 ? "attempt" : "other"; },
        get status(): "delivered" | "unknown" { return ++counts.status === 1 ? "delivered" : "unknown"; },
      };
      return { value, counts };
    };
    const added = makeReceipt();
    expect(outbox.enqueue(added.value)).toEqual({ created: true });
    expect(added.counts).toEqual({ hostId: 1, commandId: 1, attemptId: 1, status: 1 });
    expect(outbox.pending()).toEqual([{ hostId: "host", commandId: "command", attemptId: "attempt", status: "delivered" }]);
    const ack = makeReceipt();
    outbox.acknowledge(ack.value);
    expect(ack.counts).toEqual({ hostId: 1, commandId: 1, attemptId: 1, status: 1 });
    expect(outbox.pending()).toEqual([]);
  } finally { db.close(); }
});

test("replacement characters and emoji remain distinct valid receipts", () => {
  const db = new Database(":memory:");
  try {
    const outbox = new ReceiptOutbox(db);
    expect(outbox.enqueue(replacement)).toEqual({ created: true });
    expect(outbox.enqueue(emoji)).toEqual({ created: true });
    expect(outbox.pending()).toEqual([replacement, emoji]);
    outbox.acknowledge(replacement);
    expect(outbox.pending()).toEqual([emoji]);
    outbox.acknowledge(emoji);
    expect(outbox.pending()).toEqual([]);
    expect(outbox.enqueue(replacement)).toEqual({ created: false });
    expect(outbox.enqueue(emoji)).toEqual({ created: false });
  } finally { db.close(); }
});
