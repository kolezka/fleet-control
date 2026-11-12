import type { SQL, TransactionSQL } from "bun";
import { expect, test } from "bun:test";
import { CooperativeInspection } from "./cooperative-inspection.ts";

const rows = ["1", "2"].map((seq) => ({
  id: "cmd", idempotencyKey: "key", hostId: "host", target: "session", actor: "operator",
  text: "work", status: "claimed", createdAt: "time", updatedAt: "time", oversized: false,
  incarnationId: null, claimRequestId: null, claimCreatedAt: null,
  seq, eventRequestId: seq, eventStatus: "accepted", eventDetail: "detail", eventAt: "time",
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("bounded inspection snapshots the limit before a delayed runner", async () => {
  const gate = deferred();
  let queryLimit: unknown;
  const db = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    queryLimit = values[1];
    return Promise.resolve(rows);
  }) as unknown as TransactionSQL;
  const inspection = new CooperativeInspection(db as unknown as SQL, async (operation) => {
    await gate.promise;
    return operation(db);
  });
  const options = { limit: 1 };
  const pending = inspection.inspectBounded("cmd", options);
  options.limit = 4;
  gate.resolve();
  const result = await pending;
  expect(queryLimit).toBe(2);
  expect(result?.events.map((event) => event.seq)).toEqual(["1"]);
  expect(result?.nextCursor).toBe("1");
});

test("bounded inspection snapshots the limit while the query is pending", async () => {
  const gate = deferred();
  let queryLimit: unknown;
  const db = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    queryLimit = values[1];
    return gate.promise.then(() => rows);
  }) as unknown as SQL;
  const inspection = new CooperativeInspection(db);
  const options = { limit: 1 };
  const pending = inspection.inspectBounded("cmd", options);
  expect(queryLimit).toBe(2);
  options.limit = 4;
  gate.resolve();
  const result = await pending;
  expect(result?.events.map((event) => event.seq)).toEqual(["1"]);
  expect(result?.nextCursor).toBe("1");
});
