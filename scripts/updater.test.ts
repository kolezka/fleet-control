// The updater against real processes: a stand-in service started from a folder, a release package served
// over HTTP, a real SQLite state file. It checks the package, backs up, tries the new code on a scratch port,
// swaps, and rolls back to the old folder and database when the new code does not come up for real.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Job, runJob, scratchEnv, startService, stopService, restartService, waitDown, type JobFile } from "./updater.ts";

const root = mkdtempSync(join(tmpdir(), "updater-"));
const managers: JobFile["service"]["manager"][] = [];
const files = new Map<string, Buffer>();
const web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { const b = files.get(new URL(req.url).pathname); return b ? new Response(new Blob([new Uint8Array(b)])) : new Response("no", { status: 404 }); } });
afterAll(() => { for (const m of managers) stopService(m); web.stop(true); rmSync(root, { recursive: true, force: true }); }, 60_000);

const free = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port; s.stop(true); return p; };
const sha = (b: Buffer) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

// A stand-in service: answers 401 on /api/whoami and says which release it is. `rule` may make it refuse to start.
function serviceCode(dir: string, commit: string, rule = "", sync = "") {
  mkdirSync(join(dir, "vendor/agent-fleet/scripts"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "index.ts"), `${rule}\nBun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: (r) => new URL(r.url).pathname === "/api/whoami" ? new Response("${commit}", { status: 401 }) : new Response("x") });\n`);
  writeFileSync(join(dir, "vendor/agent-fleet/scripts/fleet"), `#!/bin/sh\necho "${commit.slice(0, 1)} synced PATH=$PATH" >> "$FLEET_CONF.sync"\n${sync}\n`);
  chmodSync(join(dir, "vendor/agent-fleet/scripts/fleet"), 0o755);
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ name: "fleet-control", commit }));
}

function publish(name: string, commit: string, rule = "", tamper = false, sync = "") {
  const stage = mkdtempSync(join(root, "stage-"));
  serviceCode(join(stage, "fleet-control"), commit, rule, sync);
  const pkg = join(stage, "p.tgz");
  expect(spawnSync("tar", ["-czf", pkg, "-C", stage, "fleet-control"]).status).toBe(0);
  const bytes = readFileSync(pkg);
  files.set(`/${name}/pkg.tar.gz`, bytes);
  files.set(`/${name}/pkg.tar.gz.sha256`, Buffer.from(`${tamper ? "0".repeat(64) : sha(bytes)}  pkg.tar.gz\n`));
  return { packageUrl: `${web.url}${name}/pkg.tar.gz`, sha256Url: `${web.url}${name}/pkg.tar.gz.sha256` };
}

async function setup(name: string) {
  const base = join(root, name);
  const dir = join(base, "service");
  mkdirSync(base, { recursive: true });
  serviceCode(dir, "a".repeat(40));
  const db = join(base, "state.db");
  const d = new Database(db); d.run("CREATE TABLE t (v TEXT)"); d.run("INSERT INTO t VALUES ('before')"); d.close();
  const conf = join(base, "fleet.conf"); writeFileSync(conf, "FLEET=x\n");
  const tokens = join(base, "tokens"); writeFileSync(tokens, "op abc operator\n", { mode: 0o600 });
  const port = free();
  const env = { PATH: `/service/path:${process.env.PATH!}`, HOME: process.env.HOME!, PORT: String(port), FLEET_CONTROL_DB: db };
  const manager = { kind: "test" as const, pidFile: join(base, "pid"), env, log: join(base, "service.log"), failStartsFile: join(base, "fail-starts"), failStopFile: join(base, "fail-stop") };
  managers.push(manager);
  const { startService } = await import("./updater.ts");
  startService(manager, dir);
  const health = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && !(await fetch(`${health}/api/whoami`).then((r) => r.status === 401, () => false)); i++) await Bun.sleep(100);
  const jobs = join(base, "updates"); mkdirSync(jobs);
  const job = (commit: string, urls: { packageUrl: string; sha256Url: string }): Job => {
    const data: JobFile = {
      id: "upd-20261123T120000Z-0000abcd", action: "update", tag: "v1", commit, ...urls, by: "op", state: "starting", steps: [], startedAt: new Date().toISOString(), endedAt: null, pid: null,
      service: { dir, manager, db, files: [tokens, conf], fleetConf: conf, rollbackRoot: base, health, env, waits: { scratch: 8, start: 8 } },
    };
    const f = join(jobs, `${data.id}.json`);
    writeFileSync(f, JSON.stringify(data));
    writeFileSync(join(jobs, "lock"), data.id);
    return Job.read(f);
  };
  const running = async () => (await fetch(`${health}/api/whoami`).then((r) => r.text(), () => "down"));
  return { base, dir, db, jobs, job, running, conf, tokens };
}

test("an update checks the package, backs up, tries it on a scratch port, swaps and runs the new release", async () => {
  const s = await setup("ok");
  const commit = "b".repeat(40);
  const j = s.job(commit, publish("ok", commit));
  await runJob(j);
  const after = Job.read(j.file).data;
  expect(after.state).toBe("done");
  expect(after.steps.join("\n")).toMatch(/sha256 [0-9a-f]{64} matches[\s\S]*backup in [\s\S]*scratch start on 127\.0\.0\.1:\d+ answered[\s\S]*folders swapped[\s\S]*fleet sync done/);
  expect(await s.running()).toBe(commit);
  expect(JSON.parse(readFileSync(join(s.dir, "MANIFEST.json"), "utf8")).commit).toBe(commit);
  expect(JSON.parse(readFileSync(join(`${s.dir}.before-bbbbbbb`, "MANIFEST.json"), "utf8")).commit).toBe("a".repeat(40));
  const backup = join(s.base, "rollback-bbbbbbb");
  expect(readdirSync(backup).sort()).toEqual(["SHA256SUMS", "at-stop", "fleet.conf", "state.before-upgrade.db", "tokens"]);
  expect(readdirSync(join(backup, "at-stop")).sort()).toEqual(["fleet.conf", "state.db", "tokens"]);
  expect(readFileSync(join(backup, "SHA256SUMS"), "utf8")).toContain("  state.before-upgrade.db");
  // fleet sync ran from the new code with the service's PATH, not the updater's.
  expect(readFileSync(`${s.conf}.sync`, "utf8")).toMatch(/^b synced PATH=\/service\/path:/);
  // The lock goes with the job, and the work folder too.
  expect(existsSync(join(s.jobs, "lock"))).toBe(false);
  expect(existsSync(join(s.jobs, `${after.id}.work`))).toBe(false);
}, 60_000);

test("a package whose checksum does not match is refused and the running service is untouched", async () => {
  const s = await setup("tampered");
  const commit = "c".repeat(40);
  const j = s.job(commit, publish("tampered", commit, "", true));
  await runJob(j);
  const after = Job.read(j.file).data;
  expect(after.state).toBe("failed");
  expect(after.steps.at(-1)).toMatch(/package checksum [0-9a-f]{64} does not match the published 0{64}/);
  expect(await s.running()).toBe("a".repeat(40));
  expect(existsSync(`${s.dir}.before-ccccccc`)).toBe(false);
}, 60_000);

test("a package built from another commit, or new code that does not start on a scratch port, is never swapped in", async () => {
  const s = await setup("scratch");
  const other = s.job("d".repeat(40), publish("other", "e".repeat(40)));
  await runJob(other);
  expect(Job.read(other.file).data.steps.at(-1)).toMatch(/the package was built from e{40}, not d{40}/);
  const commit = "f".repeat(40);
  const broken = s.job(commit, publish("broken", commit, "process.exit(3);"));
  await runJob(broken);
  const after = Job.read(broken.file).data;
  expect(after.state).toBe("failed");
  expect(after.steps.at(-1)).toMatch(/the new code did not answer on a scratch port/);
  expect(await s.running()).toBe("a".repeat(40));
  expect(existsSync(`${s.dir}.before-fffffff`)).toBe(false);
}, 90_000);

test("new code that passes the scratch start but does not come up for real is rolled back, folder and database", async () => {
  const s = await setup("rollback");
  const commit = "9".repeat(40);
  // Starts only against the scratch copy of the database, the way a start against real state could fail.
  const j = s.job(commit, publish("rollback", commit, `if (!process.env.FLEET_CONTROL_DB?.endsWith("scratch.db")) { require("bun:sqlite"); new (require("bun:sqlite").Database)(process.env.FLEET_CONTROL_DB).run("INSERT INTO t VALUES ('written by the failed release')"); process.exit(4); }`));
  await runJob(j);
  const after = Job.read(j.file).data;
  expect(after.state).toBe("rolled_back");
  expect(after.steps.join("\n")).toMatch(/did not answer[\s\S]*rolling back[\s\S]*database put back as the stopped service left it[\s\S]*the old release answers again/);
  expect(await s.running()).toBe("a".repeat(40));
  const rows = new Database(s.db).query("SELECT v FROM t").all();
  expect(rows).toEqual([{ v: "before" }]);
  expect(existsSync(`${s.dir}.failed-9999999`)).toBe(true);
}, 150_000);

test("review fixes: a start that fails right after the stop is retried; one that keeps failing is rolled back with folders, database and files", async () => {
  const s = await setup("retry");
  writeFileSync(join(s.base, "fail-starts"), "2");
  const commit = "1".repeat(40);
  const j = s.job(commit, publish("retry", commit));
  await runJob(j);
  expect(Job.read(j.file).data.state).toBe("done");
  expect(await s.running()).toBe(commit);

  const t = await setup("startfail");
  // Every start of the new release fails (five tries), then the old one starts.
  writeFileSync(join(t.base, "fail-starts"), "5");
  const c2 = "2".repeat(40);
  // The new release's sync also rewrites fleet.conf, which the rollback must put back.
  const k = t.job(c2, publish("startfail", c2, "", false, 'echo "FLEET=changed" > "$FLEET_CONF"'));
  await runJob(k);
  const after = Job.read(k.file).data;
  expect(after.state).toBe("rolled_back");
  expect(after.steps.join("\n")).toMatch(/Bootstrap failed: 5[\s\S]*rolling back[\s\S]*old code back in place[\s\S]*database put back as the stopped service left it[\s\S]*files put back as the stopped service left them: tokens, fleet.conf[\s\S]*old fleet sync done/);
  expect(await t.running()).toBe("a".repeat(40));
  expect(readFileSync(`${t.conf}.sync`, "utf8")).toMatch(/^2 synced[\s\S]*\na synced/);
  expect(readFileSync(t.conf, "utf8")).toBe("FLEET=x\n");
  expect(existsSync(join(t.jobs, "lock"))).toBe(false);
}, 150_000);

test("review fixes: the updater removes only its own lock, and the scratch start gets only a short list of variables", async () => {
  const s = await setup("ownlock");
  const commit = "3".repeat(40);
  const j = s.job(commit, publish("ownlock", commit, "", true));
  writeFileSync(join(s.jobs, "lock"), "upd-someone-else");
  await runJob(j);
  expect(readFileSync(join(s.jobs, "lock"), "utf8")).toBe("upd-someone-else");
  const env = scratchEnv({ PATH: "/p", HOME: "/h", FLEET_CONF: "/f", FLEET_CONTROL_TOKENS: "/t", FLEET_CONTROL_ADMIN: "1", FLEET_CONTROL_PEERS: "x", FLEET_CONTROL_SETTINGS: "/s", FLEET_CONTROL_NEW_SWITCH: "1", FLEET_CONTROL_TLS_CERT: "/c" }, 5000, "/w/scratch.db");
  expect(env).toEqual({ PATH: "/p", HOME: "/h", FLEET_CONF: "/f", FLEET_CONTROL_TOKENS: "/t", PORT: "5000", FLEET_CONTROL_HOST: "127.0.0.1", FLEET_CONTROL_DB: "/w/scratch.db" });
}, 60_000);

test("review fixes: launchd and systemd are driven with the right commands, and a bootstrap that fails with 5 is retried", async () => {
  const bin = mkdtempSync(join(root, "bin-"));
  const calls = join(bin, "calls");
  const left = join(bin, "left");
  writeFileSync(left, "1");
  for (const tool of ["launchctl", "systemctl"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> ${calls}\nif [ "$1" = bootstrap ] && [ "$(cat ${left})" -gt 0 ]; then echo 0 > ${left}; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi\nif [ "$1" = bootout ]; then echo "Boot-out failed: 3: No such process" >&2; exit 3; fi\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const uid = process.getuid!();
    const l = { kind: "launchd" as const, label: "pl.test.x", plist: "/p/pl.test.x.plist" };
    stopService(l);
    await startService(l, "/d", [0, 0.1]);
    await restartService(l, "/d");
    const u = { kind: "systemd" as const, unit: "fleet-control.service", unitFile: null };
    stopService(u); await startService(u, "/d"); await restartService(u, "/d");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      `launchctl bootout gui/${uid}/pl.test.x`,
      `launchctl bootstrap gui/${uid} /p/pl.test.x.plist`,
      `launchctl bootstrap gui/${uid} /p/pl.test.x.plist`,
      `launchctl kickstart -k gui/${uid}/pl.test.x`,
      "systemctl --user stop fleet-control.service",
      "systemctl --user start fleet-control.service",
      "systemctl --user restart fleet-control.service",
    ]);
  } finally { process.env.PATH = path; }
});

test("review round 2: a stop that ends the service but reports an error still ends in a started service", async () => {
  const s = await setup("stopfail");
  writeFileSync(join(s.base, "fail-stop"), "");
  const commit = "4".repeat(40);
  const j = s.job(commit, publish("stopfail", commit));
  await runJob(j);
  const after = Job.read(j.file).data;
  expect(after.state).toBe("rolled_back");
  expect(after.steps.join("\n")).toMatch(/Boot-out failed: 5[^\n]*; rolling back[\s\S]*the old code never left its folder[\s\S]*the new code never ran; database and files left as they are[\s\S]*the old release answers again/);
  expect(after.steps.join("\n")).toContain(`the new code was left in ${s.dir}.new-4444444; remove it by hand`);
  expect(await s.running()).toBe("a".repeat(40));
}, 90_000);

test("review round 2: what the running service wrote after the backup survives a rollback (a rotated token stays rotated)", async () => {
  const s = await setup("keep");
  writeFileSync(join(s.base, "fail-starts"), "5");
  const commit = "5".repeat(40);
  // Stands in for the old service writing while the scratch start runs: after the backup, before the stop.
  const rule = `if (process.env.FLEET_CONTROL_DB?.endsWith("scratch.db")) { require("node:fs").writeFileSync(${JSON.stringify(s.tokens)}, "op rotated operator\\n"); const { Database } = require("bun:sqlite"); const d = new Database(${JSON.stringify(s.db)}); d.run("INSERT INTO t VALUES ('written after the backup')"); d.close(); }`;
  const j = s.job(commit, publish("keep", commit, rule));
  await runJob(j);
  expect(Job.read(j.file).data.state).toBe("rolled_back");
  expect(readFileSync(s.tokens, "utf8")).toBe("op rotated operator\n");
  const d = new Database(s.db); const rows = d.query("SELECT v FROM t ORDER BY rowid").all(); d.close();
  expect(rows).toEqual([{ v: "before" }, { v: "written after the backup" }]);
}, 120_000);

test("review round 3: a new release that will not stop keeps the database it may hold; the snapshot is named instead", async () => {
  const s = await setup("hung");
  const commit = "6".repeat(40);
  const pidFile = join(s.base, "hung.pid");
  // The real start writes a row, ignores SIGTERM, holds the port and never answers: a hung new release.
  const rule = `if (!process.env.FLEET_CONTROL_DB?.endsWith("scratch.db")) { const { Database } = require("bun:sqlite"); const d = new Database(process.env.FLEET_CONTROL_DB); d.run("INSERT INTO t VALUES ('written by the hung release')"); d.close(); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Promise(() => {}) }); await new Promise(() => {}); }`;
  const j = s.job(commit, publish("hung", commit, rule));
  try {
    await runJob(j);
    const after = Job.read(j.file).data;
    const steps = after.steps.join("\n");
    expect(steps).toContain(`the new code may still be running; database and files not put back; the copy is in ${join(s.base, "rollback-6666666", "at-stop")}`);
    expect(steps).not.toContain("database put back");
    const d = new Database(s.db); const rows = d.query("SELECT v FROM t ORDER BY rowid").all(); d.close();
    expect(rows).toEqual([{ v: "before" }, { v: "written by the hung release" }]);
    expect(existsSync(join(s.base, "rollback-6666666", "at-stop", "SHA256SUMS"))).toBe(true);
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
  }
}, 150_000);

test("review round 3: a process that holds the port but does not answer is not down; a closed port is", async () => {
  const net = await import("node:net");
  const held: import("node:net").Socket[] = [];
  const hung = net.createServer((c) => { held.push(c); });
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", () => r()));
  const port = (hung.address() as import("node:net").AddressInfo).port;
  try {
    expect(await waitDown(`http://127.0.0.1:${port}`, 3)).toBe(false);
  } finally { for (const c of held) c.destroy(); hung.close(); }
  expect(await waitDown(`http://127.0.0.1:${free()}`, 3)).toBe(true);
}, 30_000);
