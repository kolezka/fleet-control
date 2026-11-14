import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CommandError } from "../commands.ts";
import { CentralCommands } from "./commands.ts";

const scope = { hostId: "host", session: "session" };
const row = { id: "command", hostId: "host", target: "session", status: "queued", idempotencyKey: "key", actor: "operator", text: "text", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

function fixture(options: { owned?: boolean; guard?: boolean; status?: string } = {}) {
  const calls: { query: string; values: unknown[] }[] = [];
  const order: string[] = [];
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    calls.push({ query, values });
    if (query.includes("FROM central_command_event_lock")) { order.push("lock"); return [{ id: 1 }]; }
    if (query.includes("FROM central_commands WHERE")) {
      order.push("ownership");
      return options.owned === false ? [] : [{ ...row, status: options.status ?? row.status }];
    }
    if (query.includes("UPDATE central_commands")) { order.push("update"); return []; }
    if (query.includes("INSERT INTO central_command_events")) { order.push("insert"); return []; }
    throw new Error(`Unexpected SQL: ${query}`);
  }) as unknown as TransactionSQL;
  const db = { begin: async (fn: (tx: TransactionSQL) => Promise<unknown>) => fn(tx) } as unknown as SQL;
  const store = new CentralCommands(db, () => new Date("2026-01-02T00:00:00.000Z"));
  const guard = async () => { order.push("guard"); return options.guard !== false; };
  const invoke = (actor: string, detail: string) => store.transitionScoped("command", "accepted", actor, detail, scope, guard);
  const invokeUnscoped = (actor: string, detail: string) => store.transition("command", "accepted", actor, detail);
  return { calls, order, invoke, invokeUnscoped };
}

async function errorOf(operation: Promise<unknown>): Promise<unknown> {
  try { await operation; } catch (error) { return error; }
  return undefined;
}

for (const field of ["actor", "detail"] as const) {
  for (const [name, malformed] of [["NUL", "bad\0text"], ["high surrogate", "bad\ud800text"], ["low surrogate", "bad\udc00text"]] as const) {
    test(`scoped transition rejects ${name} in ${field} after authorization and before writes`, async () => {
      const f = fixture();
      const error = await errorOf(f.invoke(field === "actor" ? malformed : "supervisor", field === "detail" ? malformed : "accept"));
      expect(f.order).toEqual(["guard", "lock", "ownership"]);
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).kind).toBe("invalid");
    });
  }
}

test("scoped transition preserves supplementary characters in event fields", async () => {
  const f = fixture();
  const result = await f.invoke("supervisor 😀", "accepted 🚀");
  expect(result.status).toBe("accepted");
  expect(f.order).toEqual(["guard", "lock", "ownership", "update", "insert"]);
  expect(f.calls.find(({ query }) => query.includes("INSERT INTO central_command_events"))?.values.slice(0, 4)).toEqual(["command", "accepted", "supervisor 😀", "accepted 🚀"]);
});

test("guard denial precedes event encoding validation", async () => {
  const f = fixture({ guard: false });
  const error = await errorOf(f.invoke("bad\ud800actor", "bad\0detail"));
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("access denied");
  expect(f.order).toEqual(["guard"]);
});

test("ownership denial precedes event encoding validation", async () => {
  const f = fixture({ owned: false });
  const error = await errorOf(f.invoke("bad\ud800actor", "bad\0detail"));
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("access denied");
  expect(f.order).toEqual(["guard", "lock", "ownership"]);
});

test("transition conflict precedes event encoding validation", async () => {
  const f = fixture({ status: "completed" });
  const error = await errorOf(f.invoke("bad\ud800actor", "bad\0detail"));
  expect(error).toBeInstanceOf(CommandError);
  expect((error as CommandError).kind).toBe("conflict");
  expect(f.order).toEqual(["guard", "lock", "ownership"]);
});

for (const field of ["actor", "detail"] as const) {
  for (const [name, malformed] of [["NUL", "bad\0text"], ["high surrogate", "bad\ud800text"], ["low surrogate", "bad\udc00text"]] as const) {
    test(`unscoped transition rejects ${name} in ${field} before writes`, async () => {
      const f = fixture();
      const error = await errorOf(f.invokeUnscoped(field === "actor" ? malformed : "service", field === "detail" ? malformed : "accept"));
      expect(f.order).toEqual(["lock", "ownership"]);
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).kind).toBe("invalid");
    });
  }
}

test("unscoped transition preserves supplementary characters in event fields", async () => {
  const f = fixture();
  const result = await f.invokeUnscoped("service 😀", "accepted 🚀");
  expect(result.status).toBe("accepted");
  expect(f.order).toEqual(["lock", "ownership", "update", "insert"]);
  expect(f.calls.find(({ query }) => query.includes("INSERT INTO central_command_events"))?.values.slice(0, 4)).toEqual(["command", "accepted", "service 😀", "accepted 🚀"]);
});

test("unscoped not-found and conflict precede event encoding validation", async () => {
  const missing = fixture({ owned: false });
  expect((await errorOf(missing.invokeUnscoped("bad\ud800actor", "bad\0detail")) as CommandError).kind).toBe("not_found");
  const done = fixture({ status: "completed" });
  expect((await errorOf(done.invokeUnscoped("bad\ud800actor", "bad\0detail")) as CommandError).kind).toBe("conflict");
  expect(done.order).toEqual(["lock", "ownership"]);
});
