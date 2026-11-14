import { expect, test } from "bun:test";
import type { TransactionSQL } from "bun";
import { commandAccess, type CentralCommandStore } from "./commands.ts";
import type { Principal } from "../domain/identity.ts";

const operator: Principal = { name: "op", role: "operator" };
const supervisor: Principal = { name: "sup", role: "supervisor", principalId: "p-1", hostId: "host", session: "session" };
const tx = {} as TransactionSQL;

function store() {
  const calls: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args.filter((arg) => typeof arg !== "function")]);
    // Like the real store, hand the guard the scope the call was made with.
    const used = args.find((arg) => typeof arg === "object" && arg !== null && "session" in arg);
    for (const arg of args) if (typeof arg === "function") await (arg as (tx: TransactionSQL, scope: unknown) => Promise<boolean>)(tx, used);
    return { id: "c-1" } as never;
  };
  const commands: CentralCommandStore = {
    submit: record("submit"), get: record("get"), list: record("list"), transition: record("transition"),
    transitionScoped: record("transitionScoped"), getScoped: record("getScoped"), listScoped: record("listScoped"),
  };
  return { commands, calls };
}
const active = { lockActive: async () => true };
const scope = { hostId: "host", session: "session" };

test("an operator submits under its authenticated name and reads without a scope", async () => {
  const { commands, calls } = store();
  const access = commandAccess({ commands }, operator);
  await access.submit({ hostId: "h", target: "t", text: "x", idempotencyKey: "k" });
  await access.read("c-1");
  await access.list("queued", { limit: 2 });
  expect(calls).toEqual([
    ["submit", { hostId: "h", target: "t", text: "x", idempotencyKey: "k", actor: "op" }],
    ["get", "c-1"],
    ["list", "queued", undefined, { limit: 2 }],
  ]);
});

test("a supervisor reads and answers only through its own host and session", async () => {
  const { commands, calls } = store();
  const access = commandAccess({ commands, identities: active }, supervisor);
  await access.read("c-1");
  await access.list(undefined, {});
  await access.respond("c-1", "rejected", "not mine");
  await access.report("c-1", "completed", "tests pass");
  expect(calls).toEqual([
    ["getScoped", "c-1", scope],
    ["listScoped", undefined, scope, {}],
    ["transitionScoped", "c-1", "rejected", "sup", "not mine", scope],
    ["transitionScoped", "c-1", "completed", "sup", "tests pass", scope],
  ]);
});

test("a response without a reason records the decision as its detail", async () => {
  const { commands, calls } = store();
  await commandAccess({ commands, identities: active }, supervisor).respond("c-1", "accepted", "");
  expect(calls).toEqual([["transitionScoped", "c-1", "accepted", "sup", "accepted", scope]]);
});

test("a supervisor cannot submit, and an operator cannot answer", async () => {
  const { commands, calls } = store();
  await expect(commandAccess({ commands, identities: active }, supervisor).submit({ hostId: "h", target: "t", text: "x", idempotencyKey: "k" })).rejects.toThrow("access denied");
  await expect(commandAccess({ commands }, operator).respond("c-1", "accepted", "")).rejects.toThrow("access denied");
  expect(calls).toEqual([]);
});

test("the guard refuses a retired identity, a failing registry and a missing registry", async () => {
  for (const identities of [{ lockActive: async () => false }, { lockActive: async () => "yes" as never }, undefined]) {
    const { commands } = store();
    await expect(commandAccess({ commands, identities }, supervisor).read("c-1")).rejects.toThrow("access denied");
  }
  const { commands } = store();
  await expect(commandAccess({ commands, identities: { lockActive: async () => { throw new Error("database down"); } } }, supervisor).read("c-1")).rejects.toThrow("database down");
});

test("the guard checks the supervisor's identity in the store's transaction", async () => {
  const seen: unknown[] = [];
  const { commands } = store();
  await commandAccess({ commands, identities: { lockActive: async (...args) => { seen.push(args); return true; } } }, supervisor).read("c-1");
  expect(seen).toEqual([[tx, { principalId: "p-1", name: "sup", hostId: "host", session: "session" }]]);
});

test("a store without scoped methods serves operators only", async () => {
  const { commands } = store();
  const plain: CentralCommandStore = { submit: commands.submit, get: commands.get, list: commands.list, transition: commands.transition };
  const access = commandAccess({ commands: plain, identities: active }, supervisor);
  await expect(access.read("c-1")).rejects.toThrow("access denied");
  await expect(access.list(undefined, {})).rejects.toThrow("access denied");
  await expect(access.report("c-1", "running", "started")).rejects.toThrow("access denied");
});
