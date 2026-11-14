import { expect, test } from "bun:test";
import type { SQL, TransactionSQL } from "bun";
import { CentralCommands } from "./data/commands.ts";
import type { CooperativeTransactionRunner } from "./data/incarnations.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const id = "cmd-00000000-0000-0000-0000-000000000001";
const cursor = Buffer.from(JSON.stringify([createdAt, id, "host-a", "session-a", "queued"])).toString("base64url");

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

function fixture() {
  const queries: unknown[][] = [];
  const tx = (async (_parts: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(values);
    return [];
  }) as unknown as TransactionSQL;
  return { tx, queries };
}

const expectedValues = ["host-a", "host-a", "session-a", "session-a", "queued", "queued", createdAt, createdAt, id, 3];

test("list snapshots scope and pagination before a delayed runner", async () => {
  const { tx, queries } = fixture();
  const entered = gate();
  const resume = gate();
  const runner: CooperativeTransactionRunner = async (operation) => {
    entered.release();
    await resume.wait;
    return operation(tx);
  };
  const store = new CentralCommands({} as SQL, undefined, runner);
  const scope = { hostId: "host-a", target: "session-a" };
  const pagination = { limit: 2, cursor };
  const pending = store.list("queued", scope, pagination);
  await entered.wait;
  Object.assign(scope, { hostId: "host-b", target: "session-b" });
  Object.assign(pagination, { limit: 9, cursor: undefined });
  resume.release();
  expect(await pending).toEqual({ commands: [], nextCursor: null });
  expect(queries).toEqual([expectedValues]);
});

test("listScoped snapshots scope and pagination before a delayed guard", async () => {
  const { tx, queries } = fixture();
  const db = { begin: (operation: (connection: TransactionSQL) => unknown) => operation(tx) } as unknown as SQL;
  const entered = gate();
  const resume = gate();
  const seenScopes: unknown[] = [];
  const scope = { hostId: "host-a", session: "session-a" };
  const pagination = { limit: 2, cursor };
  const pending = new CentralCommands(db).listScoped("queued", scope, async (_tx, guardScope) => {
    seenScopes.push(guardScope);
    entered.release();
    await resume.wait;
    return true;
  }, pagination);
  await entered.wait;
  Object.assign(scope, { hostId: "host-b", session: "session-b" });
  Object.assign(pagination, { limit: 9, cursor: undefined });
  resume.release();
  expect(await pending).toEqual({ commands: [], nextCursor: null });
  expect(seenScopes).toEqual([{ hostId: "host-a", session: "session-a" }]);
  expect(queries).toEqual([expectedValues]);
});

test("listBounded reads the cursor getter once", async () => {
  const { tx, queries } = fixture();
  let reads = 0;
  const pagination = { limit: 2, get cursor() { reads++; return reads === 1 ? cursor : "invalid"; } };
  const store = new CentralCommands(tx as unknown as SQL);
  expect(await store.listBounded("queued", { hostId: "host-a", target: "session-a" }, pagination)).toEqual({ commands: [], nextCursor: null });
  expect(reads).toBe(1);
  expect(queries[0]?.slice(0, 10)).toEqual(expectedValues);
});
