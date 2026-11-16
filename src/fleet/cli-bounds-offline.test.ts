import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetCli } from "./cli.ts";
import { FleetError } from "../domain/fleet.ts";

// The CLI adapter stops a fleet process that hangs or prints without end, and says so.
let dir: string;
const stub = async (name: string, body: string) => {
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\n" + body + "\n");
  await chmod(path, 0o700);
  return path;
};
// 1.5 s, not 300 ms: under a loaded full suite the stub shell can still be starting at 300 ms,
// so it is killed before it writes its pid file and the check has nothing to read.
const HANG_TIMEOUT_MS = 1_500;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "fleet-cli-bounds-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test("a hung fleet status is killed at the timeout and reported, not waited on", async () => {
  const pidFile = join(dir, "pid");
  const bin = await stub("hang", `echo $$ > "${pidFile}"; exec sleep 30`);
  const started = Date.now();
  const error = await new FleetCli({ fleetBin: bin, confPath: join(dir, "fleet.conf"), timeoutMs: HANG_TIMEOUT_MS }).status().catch((e) => e);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(error).toBeInstanceOf(FleetError);
  expect(error.kind).toBe("cli_failed");
  expect(error.message).toBe("fleet status timed out; process killed");
  expect(alive(Number((await readFile(pidFile, "utf8")).trim()))).toBe(false);
});

test("a child that keeps the pipes open is killed with the fleet process", async () => {
  const pidFile = join(dir, "child");
  const bin = await stub("child", `sleep 30 & echo $! > "${pidFile}"; wait`);
  const started = Date.now();
  const error = await new FleetCli({ fleetBin: bin, confPath: join(dir, "fleet.conf"), timeoutMs: HANG_TIMEOUT_MS }).status().catch((e) => e);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(error.message).toBe("fleet status timed out; process killed");
  await Bun.sleep(50);
  expect(alive(Number((await readFile(pidFile, "utf8")).trim()))).toBe(false);
});

test("output above the limit kills the process instead of buffering it", async () => {
  const bin = await stub("flood", "exec yes screen-line");
  const error = await new FleetCli({ fleetBin: bin, confPath: join(dir, "fleet.conf"), outputLimit: 64 * 1024 }).screen("probe", 10).catch((e) => e);
  expect(error).toBeInstanceOf(FleetError);
  expect(error.message).toBe("fleet screen output too large; process killed");
});

test("a normal run inside both bounds returns its output unchanged", async () => {
  const bin = await stub("ok", 'printf "line one\\nzażółć\\n"');
  const out = await new FleetCli({ fleetBin: bin, confPath: join(dir, "fleet.conf"), timeoutMs: 5_000, outputLimit: 1024 }).screen("probe", 10);
  expect(out).toBe("line one\nzażółć\n");
});
