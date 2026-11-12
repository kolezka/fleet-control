import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DeliveryJournal, JournalError } from "./journal";
import { DeliveryExecutor } from "./executor";

const replacementId = "attempt-�";
const emojiId = "attempt-😀";

for (const surrogate of ["\ud800", "\udc00"]) {
  const code = surrogate.charCodeAt(0).toString(16);
  for (const operation of ["start", "findIntent", "get", "finish"] as const) {
    test("rejects " + code + " in attempt ID during " + operation + " without changing the replacement row", () => {
      const db = new Database(":memory:");
      try {
        const journal = new DeliveryJournal(db);
        journal.start(replacementId, "intent");
        const rows = () => db.query("SELECT id, fingerprint, status FROM host_delivery_attempts ORDER BY rowid").all();
        const before = rows();
        const invalidId = "attempt-" + surrogate;
        let error: unknown;
        try {
          if (operation === "start") journal.start(invalidId, "intent");
          else if (operation === "findIntent") journal.findIntent(invalidId, "intent");
          else if (operation === "get") journal.get(invalidId);
          else journal.finish(invalidId, "delivered");
        } catch (caught) { error = caught; }
        expect(rows()).toEqual(before);
        expect(journal.get(replacementId)).toEqual({ id: replacementId, fingerprint: "intent", status: "started" });
        expect(error).toBeInstanceOf(JournalError);
        expect((error as JournalError).kind).toBe("invalid");
      } finally { db.close(); }
    });
  }

  for (const operation of ["start", "findIntent"] as const) {
    test("rejects " + code + " in fingerprint during " + operation + " without changing rows", () => {
      const db = new Database(":memory:");
      try {
        const journal = new DeliveryJournal(db);
        journal.start(replacementId, "intent-�");
        const rows = () => db.query("SELECT id, fingerprint, status FROM host_delivery_attempts ORDER BY rowid").all();
        const before = rows();
        let error: unknown;
        try {
          if (operation === "start") journal.start(replacementId, "intent-" + surrogate);
          else journal.findIntent(replacementId, "intent-" + surrogate);
        } catch (caught) { error = caught; }
        expect(rows()).toEqual(before);
        expect(error).toBeInstanceOf(JournalError);
        expect((error as JournalError).kind).toBe("invalid");
      } finally { db.close(); }
    });
  }
}

test("executor rejects malformed attempt before lookup or send", async () => {
  const db = new Database(":memory:");
  try {
    const journal = new DeliveryJournal(db);
    let lookups = 0, sends = 0;
    const executor = new DeliveryExecutor(journal, "host", async () => { lookups++; return "instance"; }, async () => { sends++; return { exitCode: 0, stdout: "target: delivered", stderr: "" }; });
    await expect(executor.execute({ id: "attempt-\ud800", hostId: "host", target: "target", text: "text", instanceId: "instance" })).rejects.toBeInstanceOf(JournalError);
    expect(lookups).toBe(0);
    expect(sends).toBe(0);
    expect(db.query("SELECT id FROM host_delivery_attempts").all()).toEqual([]);
  } finally { db.close(); }
});

test("replacement and emoji IDs remain distinct valid attempts", () => {
  const db = new Database(":memory:");
  try {
    const journal = new DeliveryJournal(db);
    expect(journal.start(replacementId, "intent-�").authorized).toBe(true);
    expect(journal.start(emojiId, "intent-😀").authorized).toBe(true);
    expect(journal.findIntent(replacementId, "intent-�")).toEqual({ id: replacementId, fingerprint: "intent-�", status: "started" });
    expect(journal.findIntent(emojiId, "intent-😀")).toEqual({ id: emojiId, fingerprint: "intent-😀", status: "started" });
    expect(journal.finish(replacementId, "delivered").status).toBe("delivered");
    expect(journal.get(emojiId)?.status).toBe("started");
    expect(journal.finish(emojiId, "unknown").status).toBe("unknown");
    expect(journal.get(replacementId)?.status).toBe("delivered");
  } finally { db.close(); }
});
