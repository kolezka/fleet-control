import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";

const at = "2026-01-01T00:00:00.000Z";
const row = { id: "command", idempotencyKey: "key", hostId: "host", target: "session", actor: "owner", text: "work", status: "delivering", createdAt: at, updatedAt: at };
const scope = { hostId: "host", session: "session" };
const allow = async () => true;

// Every store operation must run inside the injected runner (the cooperative schema guard).
const calls: Record<string, (store: CentralCommands) => Promise<unknown>> = {
  submit: (s) => s.submit({ idempotencyKey: "key", hostId: "host", target: "session", actor: "owner", text: "work" }),
  submitBounded: (s) => s.submitBounded({ idempotencyKey: "key", hostId: "host", target: "session", actor: "owner", text: "work" }),
  transition: (s) => s.transition("command", "delivery_unknown", "service", "detail"),
  transitionScoped: (s) => s.transitionScoped("command", "accepted", "supervisor", "accept", scope, allow),
  reconcileAfterRestart: (s) => s.reconcileAfterRestart(),
  get: (s) => s.get("command"),
  getScoped: (s) => s.getScoped("command", scope, allow),
  listScoped: (s) => s.listScoped(undefined, scope, allow),
  eventsScoped: (s) => s.eventsScoped("command", scope, allow),
  list: (s) => s.list(),
  getBounded: (s) => s.getBounded("command"),
  listBounded: (s) => s.listBounded(),
  events: (s) => s.events(),
};

function fixture() {
  let inRunner = 0, outside = 0, inside = 0;
  const tx = (async (parts: TemplateStringsArray) => {
    if (inRunner) inside++; else outside++;
    const query = parts.join("?");
    if (query.includes("central_command_event_lock")) return [{ id: 1 }];
    if (query.includes("WHERE idempotency_key")) return [];
    if (query.startsWith("INSERT INTO central_commands")) return [row];
    if (query.includes("RETURNING id")) return [];
    if (query.includes("FROM central_command_events")) return [];
    return [row];
  }) as unknown as TransactionSQL;
  const db = Object.assign((async (parts: TemplateStringsArray) => { outside++; return tx(parts); }), {
    begin: async () => { outside++; throw new Error("direct transaction bypasses runner"); },
  }) as unknown as SQL;
  const runner = async <T>(operation: (tx: TransactionSQL) => Promise<T>): Promise<T> => {
    inRunner++;
    try { return await operation(tx); } finally { inRunner--; }
  };
  return { store: new CentralCommands(db, () => new Date(at), runner), outside: () => outside, inside: () => inside };
}

test("table covers every public store operation", () => {
  const names = Object.getOwnPropertyNames(CentralCommands.prototype)
    .filter((name) => !["constructor", "initialize", "begin", "submitWithMode", "listWithConnection", "eventsWithConnection"].includes(name));
  expect(names.sort()).toEqual(Object.keys(calls).sort());
});

for (const [name, call] of Object.entries(calls)) {
  test(name + " runs only inside the injected runner", async () => {
    const f = fixture();
    await call(f.store).catch((error) => { if (String(error).includes("bypasses runner")) throw error; });
    expect(f.outside()).toBe(0);
    // Guards against a method that silently stops issuing SQL through the runner.
    expect(f.inside()).toBeGreaterThan(0);
  });
}
