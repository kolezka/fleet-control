// A descendant in its own session (setsid, as ssh ControlPersist does) survives the process group
// kill and keeps the pipes open. The bounds must still hold.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetCli } from "./cli.ts";
import { fleetSender } from "./sender.ts";
import { runProbe } from "../observe/claude.ts";

const dir = mkdtempSync(join(tmpdir(), "fc-detached-"));
const pids: string[] = [];
afterAll(() => {
  for (const file of pids) try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

// The script starts a setsid child that holds stdout and stderr for 20 s, prints, then waits or exits.
function stub(name: string, after: "hang" | "exit") {
  const pidFile = join(dir, name + ".pid");
  pids.push(pidFile);
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh
perl -e 'use POSIX; if (fork() == 0) { POSIX::setsid(); open(my $f, ">", "${pidFile}"); print $f $$; close($f); sleep 20; exit 0 }'
echo sent
${after === "hang" ? "sleep 30" : "exit 0"}
`);
  chmodSync(path, 0o700);
  return path;
}

test("fleet CLI timeout returns on time although a detached descendant holds the pipes", async () => {
  const cli = new FleetCli({ fleetBin: stub("cli-hang", "hang"), confPath: "/dev/null", timeoutMs: 1500 });
  const start = Date.now();
  await expect(cli.status()).rejects.toThrow("fleet status timed out; process killed");
  expect(Date.now() - start).toBeLessThan(6000);
});

test("fleet CLI that exited returns its output although a detached descendant holds the pipes", async () => {
  const cli = new FleetCli({ fleetBin: stub("cli-exit", "exit"), confPath: "/dev/null", timeoutMs: 15000 });
  const start = Date.now();
  await expect(cli.screen("s", 5)).resolves.toBe("sent\n");
  expect(Date.now() - start).toBeLessThan(6000);
});

test("fleet send timeout gives an unknown outcome on time although a detached descendant holds the pipes", async () => {
  const send = fleetSender(stub("send-hang", "hang"), "/dev/null", undefined, 1500);
  const start = Date.now();
  expect(await send("s", "/dev/null")).toEqual({ exitCode: -1, stdout: "", stderr: "" });
  expect(Date.now() - start).toBeLessThan(6000);
});

test("fleet send that exited keeps its result although a detached descendant holds the pipes", async () => {
  const send = fleetSender(stub("send-exit", "exit"), "/dev/null", undefined, 15000);
  const start = Date.now();
  expect(await send("s", "/dev/null")).toEqual({ exitCode: 0, stdout: "sent\n", stderr: "" });
  expect(Date.now() - start).toBeLessThan(6000);
});

test("observer probe timeout returns on time although a detached descendant holds the pipe", async () => {
  const start = Date.now();
  await expect(runProbe([stub("probe-hang", "hang")], { timeoutMs: 1500 })).rejects.toThrow("timed out; process killed");
  expect(Date.now() - start).toBeLessThan(6000);
});
