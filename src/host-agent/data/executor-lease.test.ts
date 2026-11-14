import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryJournal } from "./journal";
import { ExecutorLease, openExclusiveJournal } from "./executor-lease";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function childLocks(lock: string): Promise<boolean> {
  const script = `import { Database } from "bun:sqlite"; const db = new Database(${JSON.stringify(lock)}); db.run("PRAGMA busy_timeout = 0"); try { db.run("BEGIN EXCLUSIVE"); console.log("acquired"); } catch { console.log("busy"); }`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0 || !/^(acquired|busy)$/m.test(out)) throw new Error(`lock probe failed: ${code} ${out} ${err}`);
  return out.includes("acquired");
}

async function readLine(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const reader = child.stdout.getReader();
  let text = "";
  const deadline = Bun.sleep(4000).then(() => "timeout" as const);
  while (!text.includes("\n")) {
    const next = await Promise.race([reader.read(), deadline]);
    if (next === "timeout" || next.done) {
      child.kill("SIGKILL");
      throw new Error(`child did not report: ${text} ${await new Response(child.stderr).text()}`);
    }
    text += new TextDecoder().decode(next.value);
  }
  reader.releaseLock();
  return text;
}

function path() { const dir = mkdtempSync(join(tmpdir(), "fleet-lease-")); dirs.push(dir); return join(dir, "journal.sqlite"); }

test("a second executor in the same process cannot take the lease or reconcile", () => {
  const file = path();
  const first = openExclusiveJournal(file);
  first.journal.start("live", "intent");
  expect(() => openExclusiveJournal(file)).toThrow(/another executor/);
  expect(first.journal.get("live")?.status).toBe("started");
  first.close();
  const second = openExclusiveJournal(file);
  expect(second.reconciled).toBe(1);
  expect(second.journal.get("live")?.status).toBe("unknown");
  second.close();
});

test("the lease excludes another process and is freed when the holder dies", async () => {
  const file = path();
  const setup = new Database(file); new DeliveryJournal(setup).start("live", "intent"); setup.close();
  const module = join(import.meta.dir, "executor-lease.ts");
  const script = `import { openExclusiveJournal } from ${JSON.stringify(module)}; openExclusiveJournal(${JSON.stringify(file)}); console.log("held"); await new Promise(() => {});`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    expect(await readLine(child)).toContain("held");
    expect(() => openExclusiveJournal(file)).toThrow(/another executor/);
    const check = new Database(file, { readonly: true });
    expect(check.query("SELECT status FROM host_delivery_attempts WHERE id = 'live'").get()).toEqual({ status: "unknown" });
    check.close();
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  const after = openExclusiveJournal(file);
  expect(after.reconciled).toBe(0);
  after.close();
});

test("release is idempotent and the lock can be taken again", () => {
  const lock = path() + ".executor-lock";
  const lease = ExecutorLease.acquire(lock);
  expect(lease.held).toBe(true);
  lease.release();
  lease.release();
  expect(lease.held).toBe(false);
  ExecutorLease.acquire(lock).release();
});
test("the lease stays held while only the journal is referenced", async () => {
  const file = path();
  const { journal } = openExclusiveJournal(file);
  for (let i = 0; i < 5; i++) Bun.gc(true);
  expect(await childLocks(file + ".executor-lock")).toBe(false);
  journal.start("still-mine", "intent");
});

test("a journal refuses writes after its lease is released", () => {
  const opened = openExclusiveJournal(path());
  opened.journal.start("before", "intent");
  opened.close();
  expect(() => opened.journal.start("after", "intent")).toThrow(/lease/);
});

test("a lock file that is not a database is not reported as another executor", () => {
  const file = path();
  require("node:fs").writeFileSync(file + ".executor-lock", "not a database at all, just text padding ".repeat(4));
  expect(() => openExclusiveJournal(file)).toThrow(/cannot open executor lock/);
});

test("a symlinked journal path shares the lease of its target", () => {
  const file = path();
  const { dirname, basename } = require("node:path");
  const { symlinkSync } = require("node:fs");
  const linkDir = dirname(file) + "-link";
  symlinkSync(dirname(file), linkDir);
  dirs.push(linkDir);
  const fileLink = join(dirname(file), "alias.sqlite");
  const first = openExclusiveJournal(file);
  try {
    new Database(file).close();
    symlinkSync(basename(file), fileLink);
    expect(() => openExclusiveJournal(join(linkDir, basename(file)))).toThrow(/another executor/);
    expect(() => openExclusiveJournal(fileLink)).toThrow(/another executor/);
  } finally {
    first.close();
  }
});
