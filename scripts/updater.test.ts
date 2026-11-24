// The updater against real processes: a stand-in service started from a folder, a release package served
// over HTTP, a real SQLite state file. It checks the package, backs up, tries the new code on a scratch port,
// swaps, and rolls back to the old folder and database when the new code does not come up for real.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Job, runJob, scratchEnv, startService, stopService, restartService, waitDown, fleetSessions, NO_SERVER, symlinksIn, runningConf, type JobFile } from "./updater.ts";

const root = mkdtempSync(join(tmpdir(), "updater-"));
const managers: JobFile["service"]["manager"][] = [];
const files = new Map<string, Buffer>();
const web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { const b = files.get(new URL(req.url).pathname); return b ? new Response(new Blob([new Uint8Array(b)])) : new Response("no", { status: 404 }); } });
afterAll(() => { for (const m of managers) stopService(m); web.stop(true); rmSync(root, { recursive: true, force: true }); }, 60_000);

const free = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port; s.stop(true); return p; };
const sha = (b: Buffer) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

// A stand-in service: answers 401 on /api/whoami and says which release it is. `rule` may make it refuse to start.
function serviceCode(dir: string, commit: string, rule = "", sync = "", after = "") {
  mkdirSync(join(dir, "vendor/agent-fleet/scripts"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "index.ts"), `${rule}\nBun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: (r) => new URL(r.url).pathname === "/api/whoami" ? new Response("${commit}", { status: 401 }) : new Response("x") });\n${after}`);
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
  expect(readdirSync(join(backup, "at-stop")).sort()).toEqual(["SHA256SUMS", "fleet.conf", "state.db", "tokens"]);
  expect(readFileSync(join(backup, "at-stop", "SHA256SUMS"), "utf8")).toMatch(/^[0-9a-f]{64}  fleet\.conf\n[0-9a-f]{64}  state\.db\n[0-9a-f]{64}  tokens\n$/);
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
  expect(after.steps.join("\n")).toMatch(/Boot-out failed: 5[^\n]*; rolling back[\s\S]*the new code never ran; database and files left as they are[\s\S]*the old code never left its folder[\s\S]*the old release answers again/);
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
    expect(steps).toMatch(/not put back[\s\S]*old fleet sync/);
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

test("review round 4: a rollback stop that reports an error leaves the database alone and still runs the old fleet sync", async () => {
  const s = await setup("stoperr");
  const commit = "7".repeat(40);
  // The real start writes a row, arms the failing stop and exits: the start fails and the rollback stop throws.
  const rule = `if (!process.env.FLEET_CONTROL_DB?.endsWith("scratch.db")) { const { Database } = require("bun:sqlite"); const d = new Database(process.env.FLEET_CONTROL_DB); d.run("INSERT INTO t VALUES ('written by the new release')"); d.close(); require("node:fs").writeFileSync(${JSON.stringify(join(s.base, "fail-stop"))}, ""); process.exit(4); }`;
  const j = s.job(commit, publish("stoperr", commit, rule));
  await runJob(j);
  const steps = Job.read(j.file).data.steps.join("\n");
  expect(steps).toContain(`the stop reported an error; database and files not put back; the copy is in ${join(s.base, "rollback-7777777", "at-stop")}`);
  expect(steps).toMatch(/not put back[\s\S]*old fleet sync/);
  const d = new Database(s.db); const rows = d.query("SELECT v FROM t ORDER BY rowid").all(); d.close();
  expect(rows).toEqual([{ v: "before" }, { v: "written by the new release" }]);
  expect(readFileSync(`${s.conf}.sync`, "utf8").trim().split("\n").map((l) => l.slice(0, 1))).toEqual(["7", "a"]);
}, 150_000);

// A stand-in service that, like index.ts, takes FLEET_CONF from the settings file and says which one it runs.
async function moveSetup(name: string, rule: string, opts: { linkedFrom?: boolean } = {}) {
  const base = join(root, name);
  const dir = join(base, "service");
  mkdirSync(base, { recursive: true });
  const settings = join(base, "settings.json");
  const take = `import { readFileSync as r, writeFileSync as w } from "node:fs";\nlet conf = process.env.FLEET_CONF!;\ntry { const f = JSON.parse(r(${JSON.stringify(settings)}, "utf8")).fleetConf; if (f) conf = f; } catch {}\n${rule}\n`;
  // Like index.ts: the record is written after the listener is bound.
  const after = `w(${JSON.stringify(`${settings}.running`)}, JSON.stringify({ pid: process.pid, fleetConf: conf, startedAt: new Date().toISOString() }));\n`;
  serviceCode(dir, "a".repeat(40), take, "", after);
  let old = join(base, "fleets", "old");
  mkdirSync(old, { recursive: true });
  // FLEET_DIR may be a symlink to the real folder.
  if (opts.linkedFrom) { const real = join(base, "real-old"); renameSync(old, real); symlinkSync(real, old); }
  const conf = join(old, "fleet.conf");
  writeFileSync(conf, `FLEET=old\nFLEET_DIR=${old}\nFLEET_TMUX_SOCKET=fleet-old\nAGENTS=()\n`, { mode: 0o640 });
  writeFileSync(join(old, "fleet.conf.bak-20261101T000000Z-aaaaaaaa"), "old backup\n");
  writeFileSync(join(old, "probe.txt"), "probe\n");
  writeFileSync(settings, `${JSON.stringify({ input: true })}\n`, { mode: 0o600 });
  const tokens = join(base, "tokens"); writeFileSync(tokens, "op abc operator\n", { mode: 0o600 });
  const port = free();
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, PORT: String(port), FLEET_CONF: conf };
  const manager = { kind: "test" as const, pidFile: join(base, "pid"), env, log: join(base, "service.log") };
  managers.push(manager);
  await startService(manager, dir);
  const health = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && !(await fetch(`${health}/api/whoami`).then((r) => r.status === 401, () => false)); i++) await Bun.sleep(100);
  const jobs = join(base, "updates"); mkdirSync(jobs);
  const to = { fleet: "prod", dir: join(base, "fleets", "prod"), socket: "fleet-prod" };
  const data: JobFile = {
    id: "upd-20261123T120000Z-0000abcd", action: "move", tag: null, commit: null, packageUrl: null, sha256Url: null, by: "op", state: "starting", steps: [], startedAt: new Date().toISOString(), endedAt: null, pid: null,
    service: { dir, manager, db: null, files: [tokens, conf, settings], fleetConf: conf, rollbackRoot: base, health, env, waits: { scratch: 8, start: 8 } },
    move: { from: { fleet: "old", dir: old, socket: `fc-move-none-${process.pid}` }, to, settingsFile: settings, confSha256: createHash("sha256").update(readFileSync(conf)).digest("hex") },
  };
  const f = join(jobs, `${data.id}.json`);
  writeFileSync(f, JSON.stringify(data));
  return { base, old, conf, settings, to, job: Job.read(f), health };
}

test("move: the fleet folder is copied, the copy's fleet.conf gets the new values, the settings file names it, and the restarted service runs it", async () => {
  const s = await moveSetup("move-ok", "");
  const before = readFileSync(s.conf, "utf8");
  await runJob(s.job);
  const after = Job.read(s.job.file).data;
  expect(after.state).toBe("done");
  expect(after.steps.at(-1)).toContain(`with fleet prod in ${s.to.dir}; the old folder ${s.old} is unchanged`);
  const moved = join(s.to.dir, "fleet.conf");
  expect(readFileSync(moved, "utf8")).toBe(`FLEET=prod\nFLEET_DIR=${s.to.dir}\nFLEET_TMUX_SOCKET=fleet-prod\nAGENTS=()\n`);
  expect((statSync(moved).mode & 0o777).toString(8)).toBe("640");
  expect(readdirSync(s.to.dir).sort()).toEqual(["fleet.conf", "fleet.conf.sync", "probe.txt"]);
  // fleet sync ran for the new fleet.conf, not the old one.
  expect(readFileSync(`${moved}.sync`, "utf8")).toContain("a synced");
  expect(JSON.parse(readFileSync(s.settings, "utf8"))).toEqual({ input: true, fleetConf: moved });
  expect(JSON.parse(readFileSync(`${s.settings}.running`, "utf8")).fleetConf).toBe(moved);
  // The old folder is as it was.
  expect(readFileSync(s.conf, "utf8")).toBe(before);
  expect(readdirSync(s.old).sort()).toEqual(["fleet.conf", "fleet.conf.bak-20261101T000000Z-aaaaaaaa", "probe.txt"]);
}, 60_000);

test("move: a service that comes back on the old fleet.conf counts as a failed move, and the settings file goes back", async () => {
  // This stand-in ignores the settings file, as index.ts does when it skips a file it cannot use.
  const s = await moveSetup("move-skip", "conf = process.env.FLEET_CONF!;");
  await runJob(s.job);
  const after = Job.read(s.job.file).data;
  expect(after.state).toBe("rolled_back");
  expect(after.steps.join("\n")).toContain(`the service started on ${s.conf}, not ${join(s.to.dir, "fleet.conf")}; settings file put back`);
  expect(JSON.parse(readFileSync(s.settings, "utf8"))).toEqual({ input: true });
  expect(await fetch(`${s.health}/api/whoami`).then((r) => r.status)).toBe(401);
}, 60_000);

test("move: a target folder that filled up after the check is refused before anything stops", async () => {
  const s = await moveSetup("move-used", "");
  mkdirSync(s.to.dir, { recursive: true }); writeFileSync(join(s.to.dir, "x"), "x");
  const pid = readFileSync(join(s.base, "pid"), "utf8");
  await runJob(s.job);
  const after = Job.read(s.job.file).data;
  expect([after.state, after.steps.at(-1)?.replace(/^\S+ /, "")]).toEqual(["failed", `${s.to.dir} exists and is not empty; nothing moved`]);
  expect(readFileSync(join(s.base, "pid"), "utf8")).toBe(pid);
  expect(JSON.parse(readFileSync(s.settings, "utf8"))).toEqual({ input: true });
}, 60_000);

test("move review: an empty target folder gets the files themselves, not a copy one level down", async () => {
  const s = await moveSetup("move-empty", "");
  mkdirSync(s.to.dir, { recursive: true });
  await runJob(s.job);
  const after = Job.read(s.job.file).data;
  expect(after.state).toBe("done");
  expect(readdirSync(s.to.dir).sort()).toEqual(["fleet.conf", "fleet.conf.sync", "probe.txt"]);
  expect((statSync(join(s.to.dir, "fleet.conf")).mode & 0o777).toString(8)).toBe("640");
}, 60_000);

test("move review: a FLEET_DIR that is a symlink is copied as its folder, and the old fleet.conf is not rewritten", async () => {
  const s = await moveSetup("move-link", "", { linkedFrom: true });
  const before = readFileSync(s.conf, "utf8");
  await runJob(s.job);
  expect(Job.read(s.job.file).data.state).toBe("done");
  expect(lstatSync(s.to.dir).isDirectory()).toBe(true);
  expect(lstatSync(s.to.dir).isSymbolicLink()).toBe(false);
  expect(readFileSync(s.conf, "utf8")).toBe(before);
  expect(readFileSync(join(s.to.dir, "fleet.conf"), "utf8")).toContain("FLEET=prod\n");
}, 60_000);

test("move review: a fleet.conf edited after the check, or sessions on the fleet's tmux server, stop the move before anything stops", async () => {
  const s = await moveSetup("move-recheck", "");
  const pid = readFileSync(join(s.base, "pid"), "utf8");
  writeFileSync(s.conf, `${readFileSync(s.conf, "utf8")}# edited\n`);
  await runJob(s.job);
  let after = Job.read(s.job.file).data;
  expect([after.state, after.steps.at(-1)?.replace(/^\S+ /, "")]).toEqual(["failed", `${s.conf} changed since the move was asked for; nothing moved`]);
  expect(existsSync(s.to.dir)).toBe(false);
  const t = await moveSetup("move-live", "");
  const sock = t.job.data.move!.from.socket;
  spawnSync("tmux", ["-L", sock, "-f", "/dev/null", "new-session", "-d", "-s", "live", "sleep 60"]);
  try {
    await runJob(t.job);
    after = Job.read(t.job.file).data;
    expect([after.state, after.steps.at(-1)?.replace(/^\S+ /, "")]).toEqual(["failed", "the fleet's tmux server still runs live; nothing moved"]);
    expect(readFileSync(join(t.base, "pid"), "utf8")).not.toBe("");
    expect(existsSync(t.to.dir)).toBe(false);
  } finally { spawnSync("tmux", ["-L", sock, "kill-server"]); }
  expect(readFileSync(join(s.base, "pid"), "utf8")).toBe(pid);
}, 60_000);

test("move review: a settings save during a failed move is kept; only the move's own fleetConf is undone", async () => {
  const s = await moveSetup("move-keep", "conf = process.env.FLEET_CONF!;");
  // The stand-in ignores the settings file; before it starts, the page saves models into the file.
  const orig = Job.read(s.job.file);
  const realStep = orig.step.bind(orig);
  orig.step = (t: string) => { realStep(t); if (t.startsWith("service stopped")) { const cur = JSON.parse(readFileSync(s.settings, "utf8")); writeFileSync(s.settings, JSON.stringify({ ...cur, agentModels: ["haiku"] })); } };
  await runJob(orig);
  expect(Job.read(s.job.file).data.state).toBe("rolled_back");
  expect(JSON.parse(readFileSync(s.settings, "utf8"))).toEqual({ input: true, agentModels: ["haiku"] });
}, 60_000);

test("move review 2: a tmux that cannot be run refuses the move instead of reading as no sessions", async () => {
  const s = await moveSetup("move-notmux", "");
  const pid = readFileSync(join(s.base, "pid"), "utf8");
  const was = process.env.FLEET_CONTROL_TMUX;
  process.env.FLEET_CONTROL_TMUX = join(s.base, "no-such-tmux");
  try { await runJob(s.job); } finally { if (was === undefined) delete process.env.FLEET_CONTROL_TMUX; else process.env.FLEET_CONTROL_TMUX = was; }
  const after = Job.read(s.job.file).data;
  expect(after.state).toBe("failed");
  expect(after.steps.at(-1)).toMatch(/the fleet's tmux sessions could not be checked \(.*ENOENT.*\); nothing moved$/);
  expect(readFileSync(join(s.base, "pid"), "utf8")).toBe(pid);
  expect(existsSync(s.to.dir)).toBe(false);
}, 60_000);

test("move review 2: a settings lock that never frees still restarts the service, and a service back on the new folder is a failed move, not a rollback", async () => {
  // First start on the new folder reports the old one (so the move puts back); later starts read settings.json like the real service.
  const mark = join(root, "move-lock-first");
  const s = await moveSetup("move-lock", `if (conf.includes("/prod/") && !require("node:fs").existsSync(${JSON.stringify(mark)})) { require("node:fs").writeFileSync(${JSON.stringify(mark)}, "1"); conf = process.env.FLEET_CONF!; }`);
  const job = Job.read(s.job.file);
  const realStep = job.step.bind(job);
  // A crashed writer leaves the lock behind right after the move wrote the settings file.
  job.step = (t: string) => { realStep(t); if (t.startsWith("settings file ") && t.includes(" names ")) writeFileSync(`${s.settings}.lock`, "1\n"); };
  try { await runJob(job); } finally { rmSync(`${s.settings}.lock`, { force: true }); }
  const after = Job.read(s.job.file).data;
  expect(after.state).toBe("failed");
  expect(after.steps.join("\n")).toContain(`the settings file could not be put back: locked (another change holds ${s.settings}.lock`);
  expect(after.steps.at(-1)).toContain(`runs ${join(s.to.dir, "fleet.conf")}, not the old`);
  expect(await fetch(`${s.health}/api/whoami`).then((r) => r.status)).toBe(401);
}, 60_000);

test("move review 2: symlinks in subfolders are named too", async () => {
  const s = await moveSetup("move-sublink", "");
  mkdirSync(join(s.old, "prompts"));
  symlinkSync("/etc/hosts", join(s.old, "prompts", "abs-link"));
  // The page hashed the conf before; the conf did not change, so the job still fits.
  await runJob(s.job);
  const after = Job.read(s.job.file).data;
  expect(after.state).toBe("done");
  expect(after.steps.join("\n")).toContain("symlinks copied as they were (they may point into the old folder): prompts/abs-link");
}, 60_000);

test("move review 3: an unreadable tmux socket refuses the move; a missing server does not", async () => {
  const fake = join(root, "fake-tmux");
  writeFileSync(fake, "#!/bin/sh\necho \"error connecting to /tmp/s/x (Permission denied)\" >&2\nexit 1\n", { mode: 0o755 });
  const was = process.env.FLEET_CONTROL_TMUX;
  process.env.FLEET_CONTROL_TMUX = fake;
  try { expect(() => fleetSessions("x", "/usr/bin")).toThrow("could not be checked (error connecting to /tmp/s/x (Permission denied))"); }
  finally { if (was === undefined) delete process.env.FLEET_CONTROL_TMUX; else process.env.FLEET_CONTROL_TMUX = was; }
  for (const line of ["no server running on /tmp/s/x", "error connecting to /tmp/s/x (No such file or directory)", "error connecting to /tmp/s/x (Connection refused)"]) expect(NO_SERVER.test(line)).toBe(true);
  expect(NO_SERVER.test("error connecting to /tmp/s/x (Permission denied)")).toBe(false);
});

test("move review 3: a symlink loop or a link to a folder outside is named, never followed", () => {
  const d = join(root, "links");
  mkdirSync(join(d, "sub"), { recursive: true });
  mkdirSync(join(root, "outside", "deep"), { recursive: true });
  writeFileSync(join(root, "outside", "deep", "x"), "x");
  symlinkSync(join(d, "sub"), join(d, "sub", "loop"));
  symlinkSync(join(root, "outside"), join(d, "ext"));
  const r = symlinksIn(d);
  expect(r.links).toEqual(["ext", "sub/loop"]);
  expect(r.problems).toEqual([]);
  expect(symlinksIn(join(root, "no-such")).problems[0]).toContain("ENOENT");
  expect(symlinksIn(d, 2).problems).toEqual(["stopped after 2 entries"]);
});

test("move review 4: with a service that never went down, only a record whose process still lives says what runs", () => {
  const f = join(root, "running-live.json");
  const at = new Date().toISOString();
  writeFileSync(f, JSON.stringify({ pid: process.pid, fleetConf: "/a/fleet.conf", startedAt: at }));
  expect(runningConf(f, 0, true)).toBe("/a/fleet.conf");
  expect(runningConf(f, Date.parse(at) + 1)).toBeNull();
  const dead = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim();
  writeFileSync(f, JSON.stringify({ pid: Number(dead), fleetConf: "/a/fleet.conf", startedAt: at }));
  expect(runningConf(f, 0, true)).toBeNull();
  expect(runningConf(f, 0)).toBe("/a/fleet.conf");
});

test("move review 4: tmux is asked for C messages with the character locale kept, so its no-server text reads the same everywhere", () => {
  const fake = join(root, "locale-tmux");
  writeFileSync(fake, "#!/bin/sh\nif [ \"$LC_MESSAGES\" = C ] && [ -z \"$LC_ALL\" ] && [ \"$LC_CTYPE\" = pl_PL.UTF-8 ]; then echo \"no server running on /tmp/s/x\" >&2; else echo \"brak serwera\" >&2; fi\nexit 1\n", { mode: 0o755 });
  const was = process.env.FLEET_CONTROL_TMUX, lc = process.env.LC_ALL;
  process.env.FLEET_CONTROL_TMUX = fake; process.env.LC_ALL = "pl_PL.UTF-8";
  try { expect(fleetSessions("x", "/usr/bin")).toEqual([]); }
  finally {
    if (was === undefined) delete process.env.FLEET_CONTROL_TMUX; else process.env.FLEET_CONTROL_TMUX = was;
    if (lc === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = lc;
  }
});

test("move review 5: an old service that ignores the stop is still running the old fleet; the put-back says rolled back from its live record", async () => {
  // The service running before the move ignores SIGTERM; the second start dies on the taken port without writing a record.
  const s = await moveSetup("move-stuck", `if (!conf.includes("/prod/")) process.on("SIGTERM", () => {});`);
  const stuck = JSON.parse(readFileSync(`${s.settings}.running`, "utf8")).pid as number;
  try {
    await runJob(s.job);
    const after = Job.read(s.job.file).data;
    expect(after.steps.join("\n")).toContain("the service still answers after the stop");
    expect(after.state).toBe("rolled_back");
    expect(after.steps.at(-1)).toContain("with the old fleet");
  } finally { try { process.kill(stuck, "SIGKILL"); } catch {} }
}, 90_000);
