// The updater: a process of its own that restarts or updates the host service, so it outlives the service it
// stops. The service writes a job file and starts this; this writes every step back to the same file.
// Usage: bun scripts/updater.ts <job file>
//
// Update: download the release package and its SHA-256, check both, unpack beside the service folder, back up
// the state database and config files, start the new code on a scratch loopback port with a copy of the
// database, then stop the service, swap the folders, run fleet sync, start it and wait until it answers.
// If it does not answer, swap back, put the database copy back, start the old code again.
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, fsyncSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { backup } from "./host-backup.ts";

export type Manager =
  | { kind: "launchd"; label: string; plist: string }
  | { kind: "systemd"; unit: string; unitFile: string | null }
  // Tests: the service is `bun index.ts` started from the folder, its pid in pidFile.
  | { kind: "test"; pidFile: string; env: Record<string, string>; log: string };

export type JobFile = {
  id: string;
  action: "restart" | "update";
  tag: string | null;
  commit: string | null;
  packageUrl: string | null;
  sha256Url: string | null;
  by: string;
  state: "starting" | "running" | "done" | "rolled_back" | "failed";
  steps: string[];
  startedAt: string;
  endedAt: string | null;
  pid: number | null;
  // What the updater works on. Paths are absolute.
  service: {
    dir: string;
    manager: Manager;
    db: string | null;
    // Files copied next to the database backup and put back on rollback.
    files: string[];
    fleetConf: string;
    rollbackRoot: string;
    // Where the service answers: 401 without a token means it is up.
    health: string;
    // The service's environment, for the scratch start of the new code.
    env: Record<string, string>;
    // Seconds to wait for an answer: scratch start, then the real start. Defaults 30 and 45.
    waits?: { scratch: number; start: number };
  };
};

const now = () => new Date().toISOString();

export class Job {
  constructor(readonly file: string, public data: JobFile) {}
  static read(file: string) { return new Job(file, JSON.parse(readFileSync(file, "utf8")) as JobFile); }
  save() {
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, `${JSON.stringify(this.data, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
  }
  step(line: string) { this.data.steps.push(`${now()} ${line}`); this.save(); }
  end(state: JobFile["state"], line: string) { this.data.steps.push(`${now()} ${line}`); this.data.state = state; this.data.endedAt = now(); this.save(); }
}

export class StepFailed extends Error {}
const run = (cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: "utf8", timeout: 300_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

// ---- the service manager -------------------------------------------------------------------------------

export function stopService(m: Manager) {
  if (m.kind === "launchd") {
    const r = run("launchctl", ["bootout", `gui/${process.getuid!()}/${m.label}`]);
    // Already gone counts as stopped.
    if (!r.ok && !/No such process|Could not find service/i.test(r.out)) throw new StepFailed(`launchctl bootout failed: ${r.out}`);
  } else if (m.kind === "systemd") {
    const r = run("systemctl", ["--user", "stop", m.unit]);
    if (!r.ok) throw new StepFailed(`systemctl --user stop failed: ${r.out}`);
  } else {
    if (!existsSync(m.pidFile)) return;
    const pid = Number(readFileSync(m.pidFile, "utf8"));
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { break; } spawnSync("sleep", ["0.1"]); }
    rmSync(m.pidFile, { force: true });
  }
}

export function startService(m: Manager, dir: string) {
  if (m.kind === "launchd") {
    const r = run("launchctl", ["bootstrap", `gui/${process.getuid!()}`, m.plist]);
    if (!r.ok) throw new StepFailed(`launchctl bootstrap failed: ${r.out}`);
  } else if (m.kind === "systemd") {
    const r = run("systemctl", ["--user", "start", m.unit]);
    if (!r.ok) throw new StepFailed(`systemctl --user start failed: ${r.out}`);
  } else {
    const log = openSync(m.log, "a");
    const p = Bun.spawn([process.execPath, "index.ts"], { cwd: dir, env: m.env, stdio: ["ignore", log, log], detached: true });
    p.unref();
    writeFileSync(m.pidFile, String(p.pid));
  }
}

export function restartService(m: Manager, dir: string) {
  if (m.kind === "launchd") {
    const r = run("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/${m.label}`]);
    if (!r.ok) throw new StepFailed(`launchctl kickstart failed: ${r.out}`);
  } else if (m.kind === "systemd") {
    const r = run("systemctl", ["--user", "restart", m.unit]);
    if (!r.ok) throw new StepFailed(`systemctl --user restart failed: ${r.out}`);
  } else { stopService(m); startService(m, dir); }
}

// Up means the service answers its whoami route; without a token that is 401.
export async function waitHealthy(url: string, seconds: number): Promise<boolean> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/api/whoami`, { tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(2000) } as RequestInit);
      if (r.status === 401 || r.status === 200) return true;
    } catch {}
    await Bun.sleep(500);
  }
  return false;
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

const sha256 = (file: string) => new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
const free = (path: string) => { let p = path; for (let i = 2; existsSync(p); i++) p = `${path}-${i}`; return p; };

// ---- the steps -------------------------------------------------------------------------------------------

async function download(url: string, to: string) {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new StepFailed(`download ${url} answered ${r.status}`);
  await Bun.write(to, r);
}

// Returns the folder holding the unpacked, checked new code.
export async function fetchPackage(job: Job, work: string): Promise<string> {
  const d = job.data;
  if (!d.packageUrl || !d.sha256Url || !d.commit) throw new StepFailed("the job names no package");
  const pkg = join(work, basename(new URL(d.packageUrl).pathname));
  await download(d.packageUrl, pkg);
  await download(d.sha256Url, `${pkg}.sha256`);
  const want = /^([0-9a-f]{64})\s/.exec(readFileSync(`${pkg}.sha256`, "utf8"))?.[1];
  if (!want) throw new StepFailed("the .sha256 file has no checksum");
  const got = sha256(pkg);
  if (got !== want) throw new StepFailed(`package checksum ${got} does not match the published ${want}`);
  job.step(`downloaded ${basename(pkg)}, sha256 ${got} matches`);
  const unpack = join(work, "unpacked");
  mkdirSync(unpack);
  const t = run("tar", ["-xzf", pkg, "-C", unpack]);
  if (!t.ok) throw new StepFailed(`unpack failed: ${t.out}`);
  const code = join(unpack, "fleet-control");
  let manifest: { commit?: string };
  try { manifest = JSON.parse(readFileSync(join(code, "MANIFEST.json"), "utf8")); } catch { throw new StepFailed("the package has no readable MANIFEST.json"); }
  if (manifest.commit !== d.commit) throw new StepFailed(`the package was built from ${manifest.commit}, not ${d.commit}`);
  for (const f of ["index.ts", "vendor/agent-fleet/scripts/fleet", "node_modules"]) if (!existsSync(join(code, f))) throw new StepFailed(`the package has no ${f}`);
  job.step(`unpacked; MANIFEST names commit ${d.commit}`);
  return code;
}

export function backupState(job: Job, short: string): string {
  const s = job.data.service;
  const dir = free(join(s.rollbackRoot, `rollback-${short}`));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  if (s.db && existsSync(s.db)) {
    const b = backup(s.db, join(dir, "state.before-upgrade.db"));
    lines.push(`state ${b.tables} tables ${b.rows} rows sha256 ${b.sha256}`);
  }
  for (const f of s.files) if (existsSync(f)) { copyFileSync(f, join(dir, basename(f))); lines.push(basename(f)); }
  writeFileSync(join(dir, "SHA256SUMS"), readdirSync(dir).filter((f) => f !== "SHA256SUMS").sort().map((f) => `${sha256(join(dir, f))}  ${f}\n`).join(""), { mode: 0o600 });
  job.step(`backup in ${dir}: ${lines.join(", ")}`);
  return dir;
}

// The new code on a scratch loopback port with a copy of the database: it must start and answer.
export async function scratchRun(job: Job, code: string, backupDir: string) {
  const s = job.data.service;
  const port = await freePort();
  // Scratch files live in the job's work folder, which goes when the job ends; the backup stays as it was.
  const work = dirname(dirname(code));
  const scratchDb = join(work, "scratch.db");
  if (s.db && existsSync(join(backupDir, "state.before-upgrade.db"))) copyFileSync(join(backupDir, "state.before-upgrade.db"), scratchDb);
  const env: Record<string, string> = { ...s.env, PORT: String(port), FLEET_CONTROL_HOST: "127.0.0.1", FLEET_CONTROL_DB: s.db ? scratchDb : ":memory:" };
  for (const k of ["FLEET_CONTROL_TLS_CERT", "FLEET_CONTROL_TLS_KEY", "FLEET_CONTROL_TAILNET_HOST", "FLEET_CONTROL_TAILNET_NAME", "FLEET_CONTROL_TAILNET_TLS_CERT", "FLEET_CONTROL_TAILNET_TLS_KEY", "FLEET_CONTROL_ADMIN", "FLEET_CONTROL_INPUT", "FLEET_CONTROL_AGENT_ROOTS", "FLEET_CONTROL_AGENT_MCP_URL"]) delete env[k];
  const log = join(work, "scratch.log");
  const fd = openSync(log, "w", 0o600);
  const p = Bun.spawn([process.execPath, "index.ts"], { cwd: code, env, stdio: ["ignore", fd, fd] });
  try {
    const up = await waitHealthy(`http://127.0.0.1:${port}`, s.waits?.scratch ?? 30);
    if (!up) throw new StepFailed(`the new code did not answer on a scratch port: ${readFileSync(log, "utf8").trim().split("\n").slice(-3).join(" | ")}`);
    job.step(`scratch start on 127.0.0.1:${port} answered`);
  } finally {
    p.kill(); await p.exited; closeSync(fd);
    rmSync(scratchDb, { force: true });
  }
}

export async function swapAndStart(job: Job, code: string, backupDir: string, short: string) {
  const s = job.data.service;
  const next = free(`${s.dir}.new-${short}`);
  renameSync(code, next);
  const before = free(`${s.dir}.before-${short}`);
  stopService(s.manager);
  job.step("service stopped");
  renameSync(s.dir, before);
  renameSync(next, s.dir);
  job.step(`folders swapped; the old code is in ${before}`);
  const sync = run(join(s.dir, "vendor/agent-fleet/scripts/fleet"), ["sync"], { env: { ...process.env, FLEET_CONF: s.fleetConf } });
  job.step(sync.ok ? "fleet sync done" : `fleet sync failed (${sync.out}); the old watchdog files stay`);
  startService(s.manager, s.dir);
  if (await waitHealthy(s.health, s.waits?.start ?? 45)) {
    job.end("done", `the service answers on ${s.health} with release ${short}`);
    return;
  }
  job.step(`the service did not answer on ${s.health}; rolling back`);
  stopService(s.manager);
  renameSync(s.dir, free(`${s.dir}.failed-${short}`));
  renameSync(before, s.dir);
  if (s.db && existsSync(join(backupDir, "state.before-upgrade.db"))) {
    copyFileSync(join(backupDir, "state.before-upgrade.db"), s.db);
    for (const ext of ["-wal", "-shm"]) rmSync(`${s.db}${ext}`, { force: true });
    job.step("database put back from the backup");
  }
  startService(s.manager, s.dir);
  const back = await waitHealthy(s.health, s.waits?.start ?? 45);
  job.end(back ? "rolled_back" : "failed", back ? "the old release answers again" : `the old release does not answer either; see the service log. Backup in ${backupDir}`);
}

export async function runJob(job: Job) {
  job.data.state = "running";
  job.data.pid = process.pid;
  job.save();
  try {
    if (job.data.action === "restart") {
      job.step("restarting the service");
      restartService(job.data.service.manager, job.data.service.dir);
      const up = await waitHealthy(job.data.service.health, 45);
      job.end(up ? "done" : "failed", up ? `the service answers on ${job.data.service.health}` : `the service does not answer on ${job.data.service.health}; see its log`);
      return;
    }
    const short = job.data.commit!.slice(0, 7);
    const work = join(dirname(job.file), `${job.data.id}.work`);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    try {
      const code = await fetchPackage(job, work);
      const b = backupState(job, short);
      await scratchRun(job, code, b);
      await swapAndStart(job, code, b, short);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } catch (e) {
    // Nothing was swapped when a step before the swap fails, so the running service is untouched.
    if (job.data.state === "running") job.end("failed", `${e instanceof StepFailed ? "" : "error: "}${e instanceof Error ? e.message : e}`);
  } finally {
    rmSync(join(dirname(job.file), "lock"), { force: true });
  }
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file || !existsSync(file) || !statSync(file).isFile()) { console.error("usage: bun scripts/updater.ts <job file>"); process.exit(2); }
  await runJob(Job.read(file));
}
