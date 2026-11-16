import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { psProcesses, runProbe, tmuxPanePids } from "./claude.ts";

// Model observation runs tmux and ps for every session in a list; a stuck probe must end quickly
// with its children, and fail instead of returning partial output.
const dir = await mkdtemp(join(tmpdir(), "probe-bounds-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
// 1.5 s, not 300 ms: under a loaded full suite the stub shell can still be starting at 300 ms,
// so it is killed before it writes its pid file and the check has nothing to read.
const HANG_TIMEOUT_MS = 1_500;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a hung probe is killed with the child holding its pipe and fails", async () => {
  const pidFile = join(dir, "child");
  const bin = join(dir, "hang");
  await writeFile(bin, `#!/bin/sh\necho 123\nsleep 30 & echo $! > "${pidFile}"\nwait\n`);
  await chmod(bin, 0o700);
  const started = Date.now();
  await expect(runProbe([bin], { timeoutMs: HANG_TIMEOUT_MS })).rejects.toThrow("timed out; process killed");
  expect(Date.now() - started).toBeLessThan(5_000);
  await Bun.sleep(50);
  expect(alive(Number((await readFile(pidFile, "utf8")).trim()))).toBe(false);
});

test("oversized probe output is refused, not truncated", async () => {
  await expect(runProbe(["sh", "-c", "yes 1 | head -c 100000"], { outputLimit: 1000 })).rejects.toThrow("output too large");
});

test("a quick probe returns its exit code and output", async () => {
  expect(await runProbe(["sh", "-c", "echo 5; exit 3"])).toEqual({ code: 3, out: "5\n" });
});

test("tmux and ps readers go through the bounded probe", async () => {
  const calls: string[][] = [];
  const probe = async (argv: string[]) => { calls.push(argv); return { code: 0, out: "41\n42\n" }; };
  expect(await tmuxPanePids("fleet-x", probe)("alpha")).toEqual([41, 42]);
  expect(await psProcesses(probe)).toEqual([]);
  expect(calls.map((c) => c[0])).toEqual(["tmux", "ps"]);
});
