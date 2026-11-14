import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryJournal, JournalError } from "./journal";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function path() { const dir = mkdtempSync(join(tmpdir(), "fleet-journal-")); dirs.push(dir); return join(dir, "journal.sqlite"); }

test("records an attempt once and refuses conflicting intent", () => {
  const db = new Database(path());
  const journal = new DeliveryJournal(db);
  const first = journal.start("attempt-1", "intent-a");
  expect(first.authorized).toBe(true);
  expect(first.attempt).toEqual({ id: "attempt-1", fingerprint: "intent-a", status: "started" });
  expect(journal.start("attempt-1", "intent-a")).toEqual({ authorized: false, attempt: first.attempt });
  expect(() => journal.start("attempt-1", "intent-b")).toThrow(JournalError);
  expect(journal.get("attempt-1")).toEqual(first.attempt);
  expect(() => journal.start("", "intent")).toThrow(JournalError);
  expect(() => journal.start("x", " ")).toThrow(JournalError);
  db.close();
});

test("outcomes survive reopening and terminal states cannot be overwritten", () => {
  const file = path();
  let db = new Database(file);
  let journal = new DeliveryJournal(db);
  journal.start("delivered", "one");
  journal.start("uncertain", "two");
  expect(journal.finish("delivered", "delivered").status).toBe("delivered");
  expect(journal.finish("uncertain", "unknown").status).toBe("unknown");
  expect(() => journal.finish("delivered", "unknown")).toThrow(JournalError);
  expect(() => journal.finish("missing", "unknown")).toThrow(JournalError);
  db.close();
  db = new Database(file);
  journal = new DeliveryJournal(db);
  expect(journal.start("delivered", "one")).toEqual({ authorized: false, attempt: { id: "delivered", fingerprint: "one", status: "delivered" } });
  expect(journal.start("uncertain", "two").attempt.status).toBe("unknown");
  db.close();
});

test("restart reconciliation makes started attempts unknown without authorizing replay", () => {
  const file = path();
  let db = new Database(file);
  let journal = new DeliveryJournal(db);
  journal.start("interrupted", "intent");
  journal.start("complete", "other");
  journal.finish("complete", "delivered");
  db.close();
  db = new Database(file);
  journal = new DeliveryJournal(db);
  expect(journal.reconcileAfterRestart()).toBe(1);
  expect(journal.reconcileAfterRestart()).toBe(0);
  expect(journal.start("interrupted", "intent")).toEqual({ authorized: false, attempt: { id: "interrupted", fingerprint: "intent", status: "unknown" } });
  expect(journal.get("complete")?.status).toBe("delivered");
  db.close();
});

test.each(["start", "finish", "reconcile"] as const)("%s refuses caller transactions without changing journal or caller work", (operation) => {
    const db = new Database(path());
    const journal = new DeliveryJournal(db);
    journal.start("existing", "intent");
    db.run("CREATE TABLE caller_work (value TEXT)");
    db.run("BEGIN");
    db.run("INSERT INTO caller_work VALUES ('preserved')");
    const mutate = () => {
      if (operation === "start") return journal.start("new", "intent");
      if (operation === "finish") return journal.finish("existing", "delivered");
      return journal.reconcileAfterRestart();
    };
    expect(mutate).toThrow(/transaction/i);
    expect(db.inTransaction).toBe(true);
    expect(journal.get("new")).toBeNull();
    expect(journal.get("existing")?.status).toBe("started");
    db.run("COMMIT");
    expect(db.query("SELECT value FROM caller_work").get()).toEqual({ value: "preserved" });
    expect(journal.get("new")).toBeNull();
    expect(journal.get("existing")?.status).toBe("started");
    db.close();
});

test("independent concurrent processes authorize only one execution", async () => {
  const file = path();
  const module = join(import.meta.dir, "journal.ts");
  const setup = new Database(file); new DeliveryJournal(setup); setup.close();
  const script = `import { Database } from 'bun:sqlite'; import { DeliveryJournal } from ${JSON.stringify(module)}; const db = new Database(${JSON.stringify(file)}); const journal = new DeliveryJournal(db); console.log(JSON.stringify(journal.start('same', 'intent'))); db.close();`;
  const processes = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(processes.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })));
  expect(results.map((r) => ({ code: r.code, err: r.err }))).toEqual(results.map(() => ({ code: 0, err: "" })));
  expect(results.map((r) => JSON.parse(r.out).authorized).filter(Boolean)).toHaveLength(1);
});
