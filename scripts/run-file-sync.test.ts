import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Commands } from "../src/data/commands.ts";
import { Deliverer } from "../src/application/delivery.ts";
import { Requests } from "../src/data/requests.ts";
import { Store } from "../src/data/store.ts";
import { serve } from "../src/server.ts";
import { readTokenFile, serviceUrl } from "./run-file-sync.ts";

const fleet = { screen: async () => "", status: async () => ({ sessions: [] }) } as never;
let server: ReturnType<typeof serve>;
let requests: Requests;
beforeAll(() => {
  const store = new Store(":memory:");
  const commands = new Commands(store.db);
  requests = new Requests(store.db);
  server = serve({ fleet, store, control: { commands, deliverer: new Deliverer(commands, async () => ({ exitCode: 0, stdout: "", stderr: "" })), requests } }, 0);
});
afterAll(() => server.stop(true));

const runMd = (rows: string) => `# Phased run: Retry\n\n## Phases\n| # | Title | Status | Tip | Verified by orchestrator | Review |\n|---|---|---|---|---|---|\n${rows}\n`;
const dir = mkdtempSync(join(tmpdir(), "run-file-sync-"));
const file = join(dir, "run.md");
const run = async (...extra: string[]) => {
  const child = Bun.spawn(["bun", "scripts/run-file-sync.ts", file, "--run-id", "run-1", "--orchestrator", "supervisor", ...extra], {
    env: { PATH: process.env.PATH ?? "", FLEET_CONTROL_URL: server.url.origin }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, text: (out + err).trim() };
};

test("run.md drives the run record: dry run writes nothing, apply registers, a phase change starts a new revision and stales the old request", async () => {
  writeFileSync(file, runMd("| 1 | Parser | running | | | |\n| 2 | Docs | todo | | | |"));
  const dry = await run();
  expect(dry).toEqual({ code: 0, text: 'would register run-1 at "phase 1: Parser" then set "running; 0 of 2 done" (pass --apply to write)' });
  expect(requests.listRuns().runs).toHaveLength(0);

  expect((await run("--apply")).text).toBe('did register run-1 at "phase 1: Parser" then set "running; 0 of 2 done"; now r1');
  expect(requests.listRuns().runs[0]).toMatchObject({ phase: "phase 1: Parser", phaseStatus: "running; 0 of 2 done", revision: 1, orchestrator: "supervisor" });
  expect((await run("--apply")).text).toBe("run record already matches run.md");

  // A note in the same phase keeps the revision, so an open request stays open.
  const first = requests.create({ runId: "run-1", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Ship the parser?" });
  writeFileSync(file, runMd("| 1 | Parser | running, tests green | | | |\n| 2 | Docs | todo | | | |"));
  expect((await run("--apply")).text).toContain("now r1");
  expect(requests.get(first.id).status).toBe("open");

  // A new commit in the same phase is new work: the approval given for the old one must not carry over.
  writeFileSync(file, runMd("| 1 | Parser | running | abc1234 | | |\n| 2 | Docs | todo | | | |"));
  expect((await run("--apply")).text).toBe('did update run-1 r1 to "phase 1: Parser" / "running at abc1234; 0 of 2 done" as new work; now r2, 1 open request(s) became stale');
  expect(requests.get(first.id).status).toBe("stale");

  // So is a fix round.
  const second = requests.create({ runId: "run-1", origin: "supervisor", expectedRevision: 2, kind: "approval", question: "Ship it?" });
  writeFileSync(file, runMd("| 1 | Parser | fix-round-1 | abc1234 | | |\n| 2 | Docs | todo | | | |"));
  expect((await run("--apply")).text).toContain("as new work; now r3, 1 open request(s) became stale");
  expect(requests.get(second.id).status).toBe("stale");

  const third = requests.create({ runId: "run-1", origin: "supervisor", expectedRevision: 3, kind: "approval", question: "Start docs?" });
  writeFileSync(file, runMd("| 1 | Parser | done | abc1234 | | |\n| 2 | Docs | running | | | |"));
  expect((await run("--apply")).text).toBe('did update run-1 r3 to "phase 2: Docs" / "running; 1 of 2 done"; now r4, 1 open request(s) became stale');
  expect(requests.get(third.id).status).toBe("stale");

  // run.md going back a phase, or a record this script did not write, is refused.
  writeFileSync(file, runMd("| 1 | Parser | running | abc1234 | | |\n| 2 | Docs | todo | | | |"));
  expect(await run("--apply")).toEqual({ code: 1, text: "run file sync failed: run run-1 is at phase 2, run.md says 1; refusing to move it back" });
  requests.registerRun({ runId: "run-own", orchestrator: "supervisor", phase: "Phase 2 - Docs" });
  const own = Bun.spawn(["bun", "scripts/run-file-sync.ts", file, "--run-id", "run-own", "--orchestrator", "supervisor", "--apply"], {
    env: { PATH: process.env.PATH ?? "", FLEET_CONTROL_URL: server.url.origin }, stdout: "pipe", stderr: "pipe",
  });
  expect((await new Response(own.stderr).text()).trim()).toBe('run file sync failed: run run-own has phase "Phase 2 - Docs", which this script did not write; refusing to overwrite it');
  expect(requests.listRuns().runs.find((r) => r.id === "run-own")).toMatchObject({ phase: "Phase 2 - Docs", revision: 1 });
});

test("a token file readable by others is refused before connecting; a private one is read", () => {
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "secret-token-value\n", { mode: 0o644 });
  chmodSync(tokenFile, 0o644);
  expect(() => readTokenFile(tokenFile)).toThrow("private file");
  chmodSync(tokenFile, 0o600);
  expect(readTokenFile(tokenFile)).toBe("secret-token-value");
  writeFileSync(tokenFile, "two tokens\n");
  expect(() => readTokenFile(tokenFile)).toThrow("one token");
  const link = join(dir, "token-link");
  symlinkSync(tokenFile, link);
  expect(() => readTokenFile(link)).toThrow("not a symlink");
});

test("a token goes over http only to this machine, and the URL may not carry credentials", () => {
  expect(serviceUrl(undefined, true).href).toBe("http://127.0.0.1:4871/mcp");
  expect(serviceUrl("https://192.168.50.4:4871", true).href).toBe("https://192.168.50.4:4871/mcp");
  expect(serviceUrl("http://192.168.50.4:4871", false).href).toBe("http://192.168.50.4:4871/mcp");
  expect(() => serviceUrl("http://192.168.50.4:4871", true)).toThrow("only over https");
  expect(() => serviceUrl("https://me:pw@192.168.50.4:4871", true)).toThrow("credentials");
});

test("a flag without a value is a usage error, not a value", async () => {
  const child = Bun.spawn(["bun", "scripts/run-file-sync.ts", file, "--run-id", "--apply", "--orchestrator", "supervisor"], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(2);
});

test("an unreadable run.md and a foreign orchestrator are refused without writing", async () => {
  writeFileSync(file, runMd("| 1 | Parser | finished | | | |"));
  const bad = await run("--apply");
  expect(bad.code).toBe(1);
  expect(bad.text).toBe('run file sync failed: phase 1 has unknown status "finished"');

  writeFileSync(file, runMd("| 1 | Parser | done | | | |\n| 2 | Docs | done | | | |"));
  const child = Bun.spawn(["bun", "scripts/run-file-sync.ts", file, "--run-id", "run-1", "--orchestrator", "intruder", "--apply"], {
    env: { PATH: process.env.PATH ?? "", FLEET_CONTROL_URL: server.url.origin }, stdout: "pipe", stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(err).toContain("phase_update");
  expect(requests.listRuns().runs.find((r) => r.id === "run-1")).toMatchObject({ phase: "phase 2: Docs", revision: 4 });
});
