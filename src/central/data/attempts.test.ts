import { SQL } from "bun";
import { expect, test } from "bun:test";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "../test-database-url.ts";
import { CentralCommands } from "./commands.ts";
import { CentralAttempts } from "./attempts.ts";

const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

integration("delivery attempts serialize dispatch and authenticate idempotent receipts", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  try {
    const commands = new CentralCommands(db);
    const attempts = new CentralAttempts(db);
    const second = new CentralAttempts(other);
    await commands.initialize();
    await attempts.initialize();
    const makeCommand = async () => (await commands.submit({ idempotencyKey: crypto.randomUUID(), hostId: "host-a", target: "supervisor", actor: "client", text: "run" })).command;
    const command = await makeCommand();
    await expect(attempts.begin(command.id, "host-b")).rejects.toThrow(/host/);
    const starts = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? attempts : second).begin(command.id, "host-a")));
    const winners = starts.filter((start) => start.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const attempt = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof attempts.begin>>>).value;
    expect((await commands.events(command.id)).map((event) => event.status)).toEqual(["queued", "delivering"]);
    await expect(attempts.finish(command.id, "host-b", attempt.id, "delivered", "sent")).rejects.toThrow(/host/);
    await expect(attempts.finish(command.id, "host-a", "wrong", "delivered", "sent")).rejects.toThrow(/attempt/);
    await expect(attempts.finish(command.id, "host-a", attempt.id, "queued" as never, "sent")).rejects.toThrow(/invalid/);
    const receipts = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? attempts : second).finish(command.id, "host-a", attempt.id, "delivered", "sent")));
    expect(receipts.every((receipt) => receipt.status === "delivered")).toBe(true);
    await expect(attempts.finish(command.id, "host-a", attempt.id, "unknown", "sent")).rejects.toThrow(/conflict/);
    await expect(attempts.finish(command.id, "host-a", attempt.id, "delivered", "different")).rejects.toThrow(/conflict/);
    expect((await commands.events(command.id)).map((event) => event.status)).toEqual(["queued", "delivering", "delivered"]);
    await commands.transition(command.id, "accepted", "worker", "accepted");
    expect(await attempts.finish(command.id, "host-a", attempt.id, "delivered", "sent")).toEqual({ ...attempt, status: "delivered", detail: "sent" });
    await commands.transition(command.id, "running", "worker", "running");
    expect(await attempts.finish(command.id, "host-a", attempt.id, "delivered", "sent")).toEqual({ ...attempt, status: "delivered", detail: "sent" });
    await commands.transition(command.id, "completed", "worker", "done");
    expect(await attempts.finish(command.id, "host-a", attempt.id, "delivered", "sent")).toEqual({ ...attempt, status: "delivered", detail: "sent" });
    expect((await commands.events(command.id)).map((event) => event.status)).toEqual(["queued", "delivering", "delivered", "accepted", "running", "completed"]);
    const uncertain = await makeCommand();
    const pending = await attempts.begin(uncertain.id, "host-a");
    await attempts.finish(uncertain.id, "host-a", pending.id, "unknown", "connection lost");
    expect((await commands.get(uncertain.id)).status).toBe("delivery_unknown");
    await expect(attempts.begin(uncertain.id, "host-a")).rejects.toThrow();
    await commands.transition(uncertain.id, "accepted", "worker", "accepted");
    expect((await attempts.finish(uncertain.id, "host-a", pending.id, "unknown", "connection lost")).status).toBe("unknown");
    await expect(attempts.finish(uncertain.id, "host-a", pending.id, "delivered", "sent")).rejects.toThrow(/conflict/);
    const changed = await makeCommand();
    const stale = await attempts.begin(changed.id, "host-a");
    await expect(commands.transition(changed.id, "queued", "service", "explicit reset")).rejects.toThrow(/cannot become queued/);
    await expect(attempts.begin(changed.id, "host-a")).rejects.toThrow();
    await attempts.finish(changed.id, "host-a", stale.id, "unknown", "lost");
    await expect(attempts.begin(changed.id, "host-a")).rejects.toThrow();
    await expect(attempts.finish(changed.id, "host-a", stale.id, "delivered", "sent")).rejects.toThrow(/conflict/);
    expect((await commands.get(changed.id)).status).toBe("delivery_unknown");
    expect((await commands.events(changed.id)).map((event) => event.status)).toEqual(["queued", "delivering", "delivery_unknown"]);

  } finally {
    await db.close();
    await other.close();
  }
});

integration("a queued command with a prior attempt cannot be dispatched again", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  try {
    const commands = new CentralCommands(db);
    const attempts = new CentralAttempts(db);
    await commands.initialize();
    await attempts.initialize();
    for (const status of ["started", "unknown", "delivered"]) {
      const command = (await commands.submit({ idempotencyKey: crypto.randomUUID(), hostId: "host-a", target: "supervisor", actor: "client", text: "run" })).command;
      const attempt = await attempts.begin(command.id, "host-a");
      if (status !== "started") await attempts.finish(command.id, "host-a", attempt.id, status as "unknown" | "delivered", "receipt");
      // Simulate legacy or inconsistent persisted state; no prior attempt is safe to replay.
      await db`UPDATE central_commands SET status = 'queued' WHERE id = ${command.id}`;
      await expect(attempts.begin(command.id, "host-a")).rejects.toThrow(/attempt/);
      const rows = await db`SELECT id FROM central_delivery_attempts WHERE command_id = ${command.id}`;
      expect(rows).toHaveLength(1);
    }
  } finally {
    await db.close();
  }
});

integration("restart reconciliation marks interrupted attempts unknown without claiming delivery", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  try {
    const commands = new CentralCommands(db);
    const attempts = new CentralAttempts(db);
    await commands.initialize();
    await attempts.initialize();
    const command = (await commands.submit({ idempotencyKey: crypto.randomUUID(), hostId: "host-a", target: "supervisor", actor: "client", text: "run" })).command;
    const attempt = await attempts.begin(command.id, "host-a");
    expect(await commands.reconcileAfterRestart()).toContain(command.id);
    expect(await attempts.reconcileAfterRestart()).toContain(attempt.id);
    const [recovered] = await db`SELECT status, detail FROM central_delivery_attempts WHERE id = ${attempt.id}`;
    expect(recovered).toEqual({ status: "unknown", detail: "service restarted during delivery" });
    await attempts.finish(command.id, "host-a", attempt.id, "delivered", "sent");
    expect((await commands.get(command.id)).status).toBe("delivered");
    expect((await commands.events(command.id)).map((event) => event.status)).toEqual(["queued", "delivering", "delivery_unknown", "delivery_unknown", "delivered"]);
    expect(await attempts.reconcileAfterRestart()).not.toContain(attempt.id);
  } finally {
    await db.close();
  }
});

integration("receipts and responses commute without losing audit or execution state", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  try {
    const commands = new CentralCommands(db);
    const secondCommands = new CentralCommands(other);
    const attempts = new CentralAttempts(db);
    const secondAttempts = new CentralAttempts(other);
    await commands.initialize();
    await attempts.initialize();
    for (const mode of ["response-first", "receipt-first", "concurrent"] as const) {
      for (const decision of ["accepted", "rejected"] as const) {
        for (const receipt of ["delivered", "unknown"] as const) {
          const command = (await commands.submit({ idempotencyKey: crypto.randomUUID(), hostId: "host-a", target: "supervisor", actor: "client", text: "run" })).command;
          const attempt = await attempts.begin(command.id, "host-a");
          const respond = () => secondCommands.transition(command.id, decision, "supervisor", decision);
          const finish = () => secondAttempts.finish(command.id, "host-a", attempt.id, receipt, "receipt");
          if (mode === "response-first") { await respond(); await finish(); }
          else if (mode === "receipt-first") { await finish(); await respond(); }
          else await Promise.all([respond(), finish()]);
          expect((await commands.get(command.id)).status).toBe(decision);
          const events = await commands.events(command.id);
          expect(events.filter((event) => event.detail.includes(`receipt ${attempt.id}: ${receipt}`))).toHaveLength(1);
          await finish();
          expect(await commands.events(command.id)).toHaveLength(4);
          await expect(attempts.begin(command.id, "host-a")).rejects.toThrow();
        }
      }
    }
    for (const finalStatus of ["accepted", "running", "completed", "rejected", "failed"] as const) {
      const command = (await commands.submit({ idempotencyKey: crypto.randomUUID(), hostId: "host-a", target: "supervisor", actor: "client", text: "run" })).command;
      const attempt = await attempts.begin(command.id, "host-a");
      await commands.transition(command.id, finalStatus === "rejected" ? "rejected" : "accepted", "supervisor", "response");
      if (finalStatus === "running" || finalStatus === "completed" || finalStatus === "failed") await commands.transition(command.id, "running", "supervisor", "running");
      if (finalStatus === "completed" || finalStatus === "failed") await commands.transition(command.id, finalStatus, "supervisor", "done");
      expect(await commands.reconcileAfterRestart()).not.toContain(command.id);
      expect(await attempts.reconcileAfterRestart()).toContain(attempt.id);
      await attempts.finish(command.id, "host-a", attempt.id, "delivered", "late");
      expect((await commands.get(command.id)).status).toBe(finalStatus);
      await expect(attempts.finish(command.id, "host-a", attempt.id, "unknown", "service restarted during delivery")).rejects.toThrow(/conflict/);
      expect((await commands.events(command.id)).at(-1)?.detail).toContain(`receipt ${attempt.id}: delivered`);
    }
    const command = (await commands.submit({ idempotencyKey: crypto.randomUUID(), hostId: "host-a", target: "supervisor", actor: "client", text: "run" })).command;
    const attempt = await attempts.begin(command.id, "host-a");
    await attempts.finish(command.id, "host-a", attempt.id, "unknown", "service restarted during delivery");
    await expect(attempts.finish(command.id, "host-a", attempt.id, "delivered", "late")).rejects.toThrow(/conflict/);
  } finally {
    await db.close();
    await other.close();
  }
});
