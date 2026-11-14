import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboxError, ReceiptOutbox } from "./outbox";
import type { HostReceipt } from "../domain/delivery.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function path() { const dir = mkdtempSync(join(tmpdir(), "fleet-outbox-")); dirs.push(dir); return join(dir, "outbox.sqlite"); }
const receipt: HostReceipt = { hostId: "host", commandId: "command", attemptId: "attempt", status: "unknown" };

test("receipts persist, reject conflicts, and acknowledgement retains deduplication", () => {
  const file = path();
  let db = new Database(file);
  let outbox = new ReceiptOutbox(db);
  expect(outbox.enqueue(receipt)).toEqual({ created: true });
  expect(outbox.enqueue(receipt)).toEqual({ created: false });
  for (const changed of [{ hostId: "other" }, { commandId: "other" }, { status: "delivered" as const }]) {
    expect(() => outbox.enqueue({ ...receipt, ...changed })).toThrow(OutboxError);
    expect(() => outbox.acknowledge({ ...receipt, ...changed })).toThrow(OutboxError);
  }
  expect(outbox.pending()).toEqual([receipt]);
  db.close();
  db = new Database(file); outbox = new ReceiptOutbox(db);
  expect(outbox.pending()).toEqual([receipt]);
  outbox.acknowledge(receipt);
  outbox.acknowledge(receipt);
  expect(outbox.pending()).toEqual([]);
  db.close();
  db = new Database(file); outbox = new ReceiptOutbox(db);
  expect(outbox.enqueue(receipt)).toEqual({ created: false });
  expect(outbox.pending()).toEqual([]);
  expect(() => outbox.enqueue({ ...receipt, status: "delivered" })).toThrow(OutboxError);
  expect(() => outbox.acknowledge({ ...receipt, attemptId: "missing" })).toThrow(OutboxError);
  db.close();
});

test("invalid receipts cannot enter the outbox", () => {
  const db = new Database(":memory:"); const outbox = new ReceiptOutbox(db);
  for (const invalid of [{ ...receipt, hostId: " " }, { ...receipt, commandId: "" }, { ...receipt, attemptId: "" }, { ...receipt, status: "started" }]) {
    expect(() => outbox.enqueue(invalid as HostReceipt)).toThrow(OutboxError);
  }
  expect(outbox.pending()).toEqual([]); db.close();
});

test("enqueue participates in caller transactions and rolls back", () => {
  const db = new Database(":memory:"); const outbox = new ReceiptOutbox(db);
  expect(() => db.transaction(() => { outbox.enqueue(receipt); throw new Error("abort"); })()).toThrow("abort");
  expect(outbox.pending()).toEqual([]);
  db.close();
});

test("concurrent processes insert one receipt and reject conflicting content", async () => {
  const file = path(); const module = join(import.meta.dir, "outbox.ts");
  const setup = new Database(file); new ReceiptOutbox(setup); setup.close();
  const script = `import { Database } from 'bun:sqlite'; import { ReceiptOutbox } from ${JSON.stringify(module)}; const db = new Database(${JSON.stringify(file)}); const outbox = new ReceiptOutbox(db); try { console.log(JSON.stringify(outbox.enqueue({hostId:'host',commandId:'command',attemptId:'attempt',status:process.argv[1]}))); } catch (e) { console.log(JSON.stringify({kind:e.kind})); } db.close();`;
  const processes = Array.from({ length: 12 }, (_, i) => Bun.spawn([process.execPath, "-e", script, i < 6 ? "unknown" : "delivered"], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(processes.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })));
  expect(results.map((r) => ({ code: r.code, err: r.err }))).toEqual(results.map(() => ({ code: 0, err: "" })));
  const values = results.map((r) => JSON.parse(r.out));
  expect(values.filter((v) => v.created === true)).toHaveLength(1);
  expect(values.filter((v) => v.created === false)).toHaveLength(5);
  expect(values.filter((v) => v.kind === "conflict")).toHaveLength(6);
  const db = new Database(file); const outbox = new ReceiptOutbox(db);
  expect(outbox.pending()).toHaveLength(1); db.close();
});
