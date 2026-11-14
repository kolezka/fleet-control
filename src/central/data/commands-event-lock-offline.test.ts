import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CentralCommands } from "./commands.ts";

const at = "2026-01-01T00:00:00.000Z";
const input = { idempotencyKey: "key", hostId: "host", target: "session", actor: "owner", text: "work" };
const initial = { id: "command", ...input, status: "delivering", createdAt: at, updatedAt: at };

// This fake models transaction rollback, not PostgreSQL locking.
function fixture(exists: boolean) {
  let committed = { guardWrites: 0, commands: [initial], events: 0 };
  const calls: string[] = [];
  const begin = async <T>(operation: (tx: TransactionSQL) => Promise<T>): Promise<T> => {
    const staged = structuredClone(committed);
    const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      if (query === "UPDATE fake_guard SET writes = writes + 1") { calls.push("guard"); staged.guardWrites++; return []; }
      if (query === "SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE") { calls.push("lock"); return exists ? [{ id: 1 }] : []; }
      if (query.includes("FROM central_commands WHERE idempotency_key")) { calls.push("lookup"); return []; }
      if (query.includes("FROM central_commands WHERE id =")) { calls.push("lookup"); return [staged.commands[0]]; }
      if (query.startsWith("INSERT INTO central_commands")) {
        calls.push("insert command");
        const [id, idempotencyKey, hostId, target, actor, text, createdAt, updatedAt] = values as string[];
        const row = { id: id!, idempotencyKey: idempotencyKey!, hostId: hostId!, target: target!, actor: actor!, text: text!, status: "queued", createdAt: createdAt!, updatedAt: updatedAt! };
        staged.commands.push(row); return [row];
      }
      if (query.startsWith("UPDATE central_commands")) { calls.push("update"); staged.commands[0]!.status = query.includes("delivery_unknown") ? "delivery_unknown" : values[0] as string; return [{ id: "command" }]; }
      if (query.startsWith("INSERT INTO central_command_events")) { calls.push("event"); staged.events++; return []; }
      throw new Error("Unexpected SQL: " + query);
    }) as unknown as TransactionSQL;
    const result = await operation(tx); committed = staged; return result;
  };
  const db = { begin } as unknown as SQL;
  const runner = async <T>(operation: (tx: TransactionSQL) => Promise<T>): Promise<T> => begin(async (tx) => { await tx`UPDATE fake_guard SET writes = writes + 1`; return operation(tx); });
  return { store: new CentralCommands(db, () => new Date(at), runner), calls, snapshot: () => structuredClone(committed) };
}

for (const mode of ["submit", "submitBounded", "transition", "transitionScoped", "reconcileAfterRestart"] as const) {
  for (const exists of [false, true]) {
    test(mode + (exists ? " commits with event lock" : " fails closed without event lock"), async () => {
      const f = fixture(exists);
      const before = f.snapshot();
      const operation = mode === "submit" || mode === "submitBounded" ? f.store[mode](input)
        : mode === "transition" ? f.store.transition("command", "accepted", "supervisor", "accept")
        : mode === "transitionScoped" ? f.store.transitionScoped("command", "accepted", "supervisor", "accept", { hostId: "host", session: "session" }, async (tx) => { await tx`UPDATE fake_guard SET writes = writes + 1`; return true; })
        : f.store.reconcileAfterRestart();
      if (!exists) {
        await expect(operation).rejects.toThrow("central command event lock row missing");
        expect(f.snapshot()).toEqual(before);
        // The runner guards every mode; transitionScoped also runs its own guard.
        expect(f.calls).toEqual(mode === "transitionScoped" ? ["guard", "guard", "lock"] : ["guard", "lock"]);
      } else {
        await operation;
        expect(f.calls).toContain("event");
        expect(f.snapshot().events).toBe(1);
        expect(f.snapshot().guardWrites).toBe(mode === "transitionScoped" ? 2 : 1);
        if (mode === "reconcileAfterRestart") expect(f.snapshot().commands[0]!.status).toBe("delivery_unknown");
      }
    });
  }
}
