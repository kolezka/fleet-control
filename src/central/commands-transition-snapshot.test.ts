import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";

test("scoped transition keeps the scope authorized before an asynchronous guard", async () => {
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const waiting = new Promise<void>((resolve) => { resume = resolve; });
  const scope = { hostId: "host-a", session: "session-a" };
  let guardedScope: typeof scope | undefined;
  let selectedScope: unknown[] | undefined;
  let otherStatus = "queued";
  const other = { id: "command", hostId: "host-b", target: "session-b", status: "queued" };
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?");
    if (sql.includes("FROM central_commands WHERE")) {
      selectedScope = values.slice(1);
      return values[0] === other.id && values[1] === other.hostId && values[2] === other.target ? [other] : [];
    }
    if (sql.includes("UPDATE central_commands")) otherStatus = String(values[0]);
    return [];
  }) as unknown as TransactionSQL;
  const db = { begin: async (operation: (tx: TransactionSQL) => Promise<unknown>) => operation(tx) } as unknown as SQL;
  const store = new CentralCommands(db);
  const pending = store.transitionScoped("command", "accepted", "supervisor", "accept", scope, async () => {
    guardedScope = { ...scope };
    enter();
    await waiting;
    return true;
  });
  await entered;
  scope.hostId = "host-b";
  scope.session = "session-b";
  resume();
  const outcome = await pending.then(() => "accepted", (error: Error) => error.message);
  expect({ guardedScope, selectedScope, otherStatus, outcome }).toEqual({
    guardedScope: { hostId: "host-a", session: "session-a" },
    selectedScope: ["host-a", "session-a"],
    otherStatus: "queued",
    outcome: "access denied",
  });
});

test("scoped transition guards and queries the original scope when begin is delayed", async () => {
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => { resume = resolve; });
  const scope = { hostId: "host-a", session: "session-a" };
  let guardedScope: typeof scope | undefined;
  let selectedScope: unknown[] | undefined;
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    if (parts.join("?").includes("FROM central_commands WHERE")) selectedScope = values.slice(1);
    return [];
  }) as unknown as TransactionSQL;
  const db = { begin: async (operation: (tx: TransactionSQL) => Promise<unknown>) => {
    await waiting;
    return operation(tx);
  } } as unknown as SQL;
  const store = new CentralCommands(db);
  const guard = async (_tx: TransactionSQL, authorizedScope: typeof scope) => {
    guardedScope = authorizedScope && { ...authorizedScope };
    return true;
  };
  const pending = store.transitionScoped("command", "accepted", "supervisor", "accept", scope, guard);
  scope.hostId = "host-b";
  scope.session = "session-b";
  resume();
  const outcome = await pending.then(() => "accepted", (error: Error) => error.message);
  expect({ guardedScope, selectedScope, outcome }).toEqual({
    guardedScope: { hostId: "host-a", session: "session-a" },
    selectedScope: ["host-a", "session-a"],
    outcome: "access denied",
  });
});
