import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CooperativeClaims } from "./cooperative-claims.ts";
import type { CooperativeTransactionRunner, SupervisorIncarnations } from "./incarnations.ts";

const principal = { role: "supervisor" as const, principalId: "principal", name: "supervisor", hostId: "host", session: "session" };
const queued = { id: "original-command", idempotencyKey: "key", hostId: "host", target: "session", actor: "operator", text: "work", status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const claimed = { ...queued, status: "claimed" };

for (const path of ["insert", "replay"] as const) {
  test(`claim ${path} stays scoped to the authenticated incarnation after await`, async () => {
    const credential = { incarnationId: "original-incarnation", token: "original-token" };
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let authenticatedId = "";
    let lookupId = "";
    let insertId = "";
    let eventDetail = "";
    const incarnations = {
      async lockForClaim(_tx: TransactionSQL, _identity: unknown, supplied: typeof credential) {
        authenticatedId = supplied.incarnationId;
        entered();
        await resume;
        return true;
      },
    } as unknown as SupervisorIncarnations;
    const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?");
      if (query.includes("FROM central_command_event_lock")) return [{ id: 1 }];
      if (query.includes("FROM central_cooperative_claims WHERE incarnation_id")) {
        lookupId = values[0] as string;
        if (path === "insert") return [];
        return [{ commandId: lookupId === "original-incarnation" ? "original-command" : "other-command" }];
      }
      if (query.includes("FROM central_commands WHERE id")) {
        return [{ ...claimed, id: values[0] }];
      }
      if (query.includes("FROM central_commands AS command")) return [queued];
      if (query.includes("UPDATE central_commands")) return [claimed];
      if (query.includes("INSERT INTO central_cooperative_claims")) { insertId = values[0] as string; return []; }
      if (query.includes("INSERT INTO central_command_events")) { eventDetail = values[2] as string; return []; }
      throw new Error(`Unexpected query: ${query}`);
    }) as unknown as TransactionSQL;
    const runner: CooperativeTransactionRunner = (operation) => operation(tx);
    const claims = new CooperativeClaims({} as SQL, incarnations, () => new Date("2026-01-01T00:00:00.000Z"), runner);

    const pending = claims.claim(principal, credential, "request");
    await locked;
    credential.incarnationId = "other-incarnation";
    credential.token = "other-token";
    release();
    const result = await pending;

    expect(authenticatedId).toBe("original-incarnation");
    if (path === "insert") {
      expect({ lookupId, insertId, eventDetail, resultId: result?.id }).toEqual({
        lookupId: authenticatedId, insertId: authenticatedId,
        eventDetail: `cooperative claim ${authenticatedId}`, resultId: "original-command",
      });
    } else {
      expect({ lookupId, resultId: result?.id }).toEqual({ lookupId: authenticatedId, resultId: "original-command" });
    }
  });
}
