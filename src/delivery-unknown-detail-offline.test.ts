import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Commands } from "./data/commands.ts";
import { classify, Deliverer, type SendResult } from "./delivery.ts";

test("unknown sender output never reaches returned or stored events", async () => {
  const db = new Database(":memory:");
  try {
    const commands = new Commands(db);
    const secret = "synthetic-secret-marker";
    const large = "large-output-marker".repeat(10_000);
    const cases: SendResult[] = [
      { exitCode: 1, stdout: `${secret}${large}`, stderr: "" },
      { exitCode: 2, stdout: "", stderr: `${secret}${large}` },
      { exitCode: 0, stdout: `${secret}${large}`, stderr: `${secret}${large}` },
      { exitCode: 1, stdout: "alpha: delivered", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    for (const [index, result] of cases.entries()) {
      const classified = classify(result, "alpha");
      expect(classified).toEqual({ status: "delivery_unknown", detail: "fleet send result unknown" });
      const id = commands.submit({ idempotencyKey: String(index), target: "alpha", actor: "test", text: "hello" }).command.id;
      const deliverer = new Deliverer(commands, async () => result, {
        mkdtemp: async () => "/fake", write: async () => {}, rm: async () => {},
      });
      expect((await deliverer.deliver(id)).status).toBe("delivery_unknown");
      const events = commands.events(id);
      expect(events.map(event => event.status)).toEqual(["queued", "delivering", "delivery_unknown"]);
      expect(events.at(-1)?.detail).toBe("fleet send result unknown");
      const stored = db.query<{ detail: string }, [string]>("SELECT detail FROM command_events WHERE command_id = ? ORDER BY seq").all(id);
      for (const output of [JSON.stringify(classified), JSON.stringify(events), JSON.stringify(stored)]) {
        expect(output).not.toContain(secret);
        expect(output).not.toContain("large-output-marker");
        expect(output.length).toBeLessThan(2000);
      }
    }
  } finally {
    db.close();
  }
});

test("exact successful confirmations retain their details and status", async () => {
  const db = new Database(":memory:");
  try {
    const commands = new Commands(db);
    for (const [index, stdout] of ["alpha: delivered", "alpha: delivered\n", "alpha: delivered\r\n"].entries()) {
      const result = { exitCode: 0, stdout, stderr: "ignored" };
      expect(classify(result, "alpha")).toEqual({ status: "delivered", detail: stdout });
      const id = commands.submit({ idempotencyKey: String(index), target: "alpha", actor: "test", text: "hello" }).command.id;
      const deliverer = new Deliverer(commands, async () => result, {
        mkdtemp: async () => "/fake", write: async () => {}, rm: async () => {},
      });
      expect((await deliverer.deliver(id)).status).toBe("delivered");
      expect(commands.events(id).at(-1)?.detail).toBe(stdout);
    }
  } finally {
    db.close();
  }
});
