import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Commands } from "../src/data/commands.ts";
import { Deliverer } from "../src/application/delivery.ts";
import { Requests } from "../src/data/requests.ts";
import { Store } from "../src/data/store.ts";
import { serve } from "../src/server.ts";

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

  // A new tip in the same phase keeps the revision, so an open request stays open.
  const open = requests.create({ runId: "run-1", origin: "supervisor", expectedRevision: 1, kind: "approval", question: "Start phase 2?" });
  writeFileSync(file, runMd("| 1 | Parser | running | abc1234 | | |\n| 2 | Docs | todo | | | |"));
  expect((await run("--apply")).text).toContain("now r1");
  expect(requests.get(open.id).status).toBe("open");

  writeFileSync(file, runMd("| 1 | Parser | done | abc1234 | | |\n| 2 | Docs | running | | | |"));
  expect((await run("--apply")).text).toBe('did update run-1 r1 to "phase 2: Docs" / "running; 1 of 2 done"; now r2, 1 open request(s) became stale');
  expect(requests.get(open.id).status).toBe("stale");
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
  expect(requests.listRuns().runs[0]).toMatchObject({ phase: "phase 2: Docs", revision: 2 });
});
