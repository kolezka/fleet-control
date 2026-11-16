import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetSender } from "./sender.ts";
import { classify } from "../domain/delivery.ts";

// A fleet send that hangs is killed with its children; the delivery stays unknown, never delivered.
const dir = await mkdtemp(join(tmpdir(), "sender-timeout-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a hung send is killed at the timeout, with the child holding its pipes, and stays unknown", async () => {
  const pidFile = join(dir, "child");
  const bin = join(dir, "fleet");
  // Prints the success line first, then hangs: a timeout must not turn that into "delivered".
  await writeFile(bin, `#!/bin/sh\necho "$2: delivered"\nsleep 30 & echo $! > "${pidFile}"\nwait\n`);
  await chmod(bin, 0o700);
  const started = Date.now();
  const result = await fleetSender(bin, "unused", undefined, 300)("alpha", "file");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result).toEqual({ exitCode: -1, stdout: "", stderr: "" });
  expect(classify(result, "alpha").status).toBe("delivery_unknown");
  await Bun.sleep(50);
  expect(alive(Number((await readFile(pidFile, "utf8")).trim()))).toBe(false);
});

test("a send that finishes inside the timeout is unchanged", async () => {
  const bin = join(dir, "quick");
  await writeFile(bin, '#!/bin/sh\necho "$2: delivered"\n');
  await chmod(bin, 0o700);
  const result = await fleetSender(bin, "unused", undefined, 5_000)("alpha", "file");
  expect(classify(result, "alpha").status).toBe("delivered");
});
