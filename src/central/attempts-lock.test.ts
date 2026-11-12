import type { SQL } from "bun";
import { expect, test } from "bun:test";
import { CentralAttempts } from "./attempts.ts";

function fakeAttempts(lockPresent: boolean, commandStatus = "queued") {
  const queries: string[] = [];
  const tx = async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes("FROM central_command_event_lock")) return lockPresent ? [{ id: 1 }] : [];
    if (query.includes("UPDATE central_delivery_attempts AS attempt")) return [{ id: "attempt-1", commandId: "command-1", commandStatus: "delivery_unknown" }];
    if (query.includes("SELECT host_id")) return [{ hostId: "host-1", status: commandStatus }];
    if (query.includes("SELECT id FROM central_delivery_attempts")) return [];
    if (query.includes("SELECT id, command_id")) return [{ id: "attempt-1", commandId: "command-1", hostId: "host-1", status: "started", detail: null, recoveryUnknown: false }];
    return [];
  };
  const db = { begin: (callback: (transaction: typeof tx) => unknown) => callback(tx) } as unknown as SQL;
  return { attempts: new CentralAttempts(db, () => new Date("2025-01-01T00:00:00Z")), queries };
}

const operations = {
  reconcile: (attempts: CentralAttempts) => attempts.reconcileAfterRestart(),
  begin: (attempts: CentralAttempts) => attempts.begin("command-1", "host-1"),
  finish: (attempts: CentralAttempts) => attempts.finish("command-1", "host-1", "attempt-1", "delivered", "sent"),
};

for (const [name, operation] of Object.entries(operations)) {
  test(`CentralAttempts ${name} rejects a missing event lock before further SQL`, async () => {
    const { attempts, queries } = fakeAttempts(false);
    await expect(operation(attempts)).rejects.toThrow("central command event lock row missing");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("FROM central_command_event_lock WHERE id = 1 FOR UPDATE");
  });
}

test("CentralAttempts proceeds through all three transactions with the lock row", async () => {
  const recovery = fakeAttempts(true);
  expect(await recovery.attempts.reconcileAfterRestart()).toEqual(["attempt-1"]);
  expect(recovery.queries).toHaveLength(3);
  const start = fakeAttempts(true);
  expect(await start.attempts.begin("command-1", "host-1")).toMatchObject({ commandId: "command-1", status: "started" });
  expect(start.queries).toHaveLength(6);
  const finish = fakeAttempts(true, "delivering");
  expect(await finish.attempts.finish("command-1", "host-1", "attempt-1", "delivered", "sent")).toMatchObject({ status: "delivered", detail: "sent" });
  expect(finish.queries).toHaveLength(6);
});
