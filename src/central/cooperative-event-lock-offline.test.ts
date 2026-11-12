import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import type { SupervisorIncarnations } from "./incarnations.ts";

const principal = { role: "supervisor" as const, principalId: "principal", name: "supervisor", hostId: "host", session: "session" };
const credential = { incarnationId: "incarnation", token: "token" };
const at = "2026-01-01T00:00:00.000Z";

// Models transaction rollback and query order, not PostgreSQL lock behavior.
function fixture(exists: boolean) {
  const calls: string[] = [];
  let committed: string[] = [];
  const begin = async (operation: (tx: TransactionSQL) => Promise<unknown>) => {
    const staged = [...committed];
    const tx = Object.assign(((parts: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof parts === "string") return parts;
      return (async () => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      if (query.includes("current_schema()")) return [{ schema: "test_schema" }];
      if (query.includes("central_command_event_lock")) { calls.push("event lock"); if (query.includes("?.central_command_event_lock")) expect(values[0]).toBe("test_schema"); return exists ? [{ id: 1 }] : []; }
      if (query.startsWith("CREATE TABLE")) { staged.push("table"); return []; }
      if (query.startsWith("DROP TRIGGER") || query.startsWith("CREATE TRIGGER")) { calls.push("trigger"); staged.push("trigger"); return []; }
      if (query.includes("FROM central_cooperative_claims WHERE incarnation_id")) { calls.push("claim lookup"); return []; }
      if (query.includes("FROM central_commands AS command")) return [{ id: "command", status: "queued" }];
      if (query.startsWith("UPDATE central_commands")) { staged.push("command"); return [{ id: "command", status: "claimed" }]; }
      if (query.startsWith("INSERT INTO central_cooperative_claims")) { staged.push("claim"); return []; }
      if (query.startsWith("INSERT INTO central_command_events")) { staged.push("command event"); return []; }
      if (query.includes("FROM central_cooperative_claims WHERE command_id")) { calls.push("claim lookup"); return [{ command_id: "command" }]; }
      if (query.includes("FROM central_cooperative_lifecycle_events")) return [];
      if (query.startsWith("INSERT INTO central_cooperative_lifecycle_events")) { staged.push("lifecycle event"); return []; }
      throw new Error("Unexpected SQL: " + query);
      })();
    }), { unsafe: async () => { staged.push("function"); } }) as unknown as TransactionSQL;
    const result = await operation(tx); committed = staged; return result;
  };
  const db = { begin } as unknown as SQL;
  const incarnations = { lockForClaim: async () => { calls.push("incarnation lock"); return true; } } as unknown as SupervisorIncarnations;
  return { calls, snapshot: () => [...committed], claims: new CooperativeClaims(db, incarnations, () => new Date(at)), lifecycle: new CooperativeLifecycle(db, incarnations, () => new Date(at)) };
}

for (const mode of ["initialize", "claim", "report"] as const) {
  for (const exists of [false, true]) {
    test(mode + (exists ? " proceeds with event lock" : " fails closed without event lock"), async () => {
      const f = fixture(exists);
      const op = mode === "initialize" ? f.claims.initialize() : mode === "claim" ? f.claims.claim(principal, credential, "request") : f.lifecycle.report(principal, credential, "command", "request", "accepted", "");
      if (!exists) {
        await expect(op).rejects.toThrow("central command event lock row missing");
        expect(f.snapshot()).toEqual([]);
        expect(f.calls).toEqual(mode === "initialize" ? ["event lock"] : ["incarnation lock", "event lock"]);
      } else {
        await op;
        expect(f.calls.slice(0, mode === "initialize" ? 1 : 2)).toEqual(mode === "initialize" ? ["event lock"] : ["incarnation lock", "event lock"]);
        expect(f.snapshot()).toContain(mode === "initialize" ? "trigger" : mode === "claim" ? "command event" : "lifecycle event");
      }
    });
  }
}
