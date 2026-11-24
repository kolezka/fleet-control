// The updater: a process of its own that restarts or updates the host service, so it outlives the service it
// stops. The service writes a job file and starts this; this writes every step back to the same file.
// Usage: bun scripts/updater.ts <job file>
//
// Update: download the release package and its SHA-256, check both, unpack beside the service folder, back up
// the state database and config files, start the new code on a scratch loopback port with a copy of the
// database, then stop the service, swap the folders, run fleet sync, start it and wait until it answers.
// If it does not answer, or any step after the stop throws, put the old folder, database and files back, run
// the old code's fleet sync and start the old code again.
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, fsyncSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, rmdirSync } from "node:fs";
import { withLock } from "./tokens.ts";
import { backup } from "./host-backup.ts";
import { movedConf } from "../src/domain/move.ts";
import type { JobFile, Manager } from "../src/domain/updates.ts";

export type { JobFile, Manager } from "../src/domain/updates.ts";

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
    // A child of this process stays a zombie until reaped, so ps decides, not kill(pid, 0).
    for (let i = 0; i < 50; i++) {
      const st = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      if (!st || st.startsWith("Z")) break;
      spawnSync("sleep", ["0.1"]);
    }
    rmSync(m.pidFile, { force: true });
    // Tests: a stop that ends the process and still reports an error, as launchctl bootout can.
    if (m.failStopFile && existsSync(m.failStopFile)) { rmSync(m.failStopFile); throw new StepFailed("Boot-out failed: 5: Input/output error (test)"); }
  }
}

// launchctl bootstrap right after a bootout can fail while launchd still tears the old job down
// ("Bootstrap failed: 5: Input/output error", 37 "Operation already in progress"); those are retried.
const BOOTSTRAP_RETRY = /Bootstrap failed: (5|37)\b|already in progress/i;
export const START_TRIES = [0, 1, 2, 4, 8];

export async function startService(m: Manager, dir: string, tries: number[] = START_TRIES) {
  let last = "";
  for (const wait of tries) {
    if (wait) await Bun.sleep(wait * 1000);
    if (m.kind === "launchd") {
      const r = run("launchctl", ["bootstrap", `gui/${process.getuid!()}`, m.plist]);
      if (r.ok) return;
      last = `launchctl bootstrap failed: ${r.out}`;
      if (!BOOTSTRAP_RETRY.test(r.out)) break;
    } else if (m.kind === "systemd") {
      // Every failure is retried here; a permanent one costs the 15 s of the waits.
      const r = run("systemctl", ["--user", "start", m.unit]);
      if (r.ok) return;
      last = `systemctl --user start failed: ${r.out}`;
    } else {
      const left = m.failStartsFile && existsSync(m.failStartsFile) ? Number(readFileSync(m.failStartsFile, "utf8")) : 0;
      if (left > 0) { writeFileSync(m.failStartsFile!, String(left - 1)); last = "Bootstrap failed: 5: Input/output error (test)"; continue; }
      const log = openSync(m.log, "a");
      const p = Bun.spawn([process.execPath, "index.ts"], { cwd: dir, env: m.env, stdio: ["ignore", log, log], detached: true });
      p.unref();
      writeFileSync(m.pidFile, String(p.pid));
      return;
    }
  }
  throw new StepFailed(last);
}

export async function restartService(m: Manager, dir: string) {
  if (m.kind === "launchd") {
    const r = run("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/${m.label}`]);
    if (!r.ok) throw new StepFailed(`launchctl kickstart failed: ${r.out}`);
  } else if (m.kind === "systemd") {
    const r = run("systemctl", ["--user", "restart", m.unit]);
    if (!r.ok) throw new StepFailed(`systemctl --user restart failed: ${r.out}`);
  } else { stopService(m); await startService(m, dir); }
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

// Down means nothing answers there any more, so whatever answers after the start is the new process.
export async function waitDown(url: string, seconds: number): Promise<boolean> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try { await fetch(`${url}/api/whoami`, { tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(1000) } as RequestInit); } catch (e) {
      // A hung process that still holds the port times out; that is not down.
      const name = e instanceof Error ? e.name : "";
      if (name !== "TimeoutError" && name !== "AbortError") return true;
    }
    await Bun.sleep(300);
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

export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
async function download(url: string, to: string) {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new StepFailed(`download ${url} answered ${r.status}`);
  if (Number(r.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES) throw new StepFailed(`download ${url} is larger than ${MAX_DOWNLOAD_BYTES} bytes`);
  // Counted while reading, so a body without content-length cannot fill the disk.
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_DOWNLOAD_BYTES) throw new StepFailed(`download ${url} is larger than ${MAX_DOWNLOAD_BYTES} bytes`);
    parts.push(chunk);
  }
  await Bun.write(to, new Blob(parts as BlobPart[]));
}

// Returns the folder holding the unpacked, checked new code.
export async function fetchPackage(job: Job, work: string): Promise<string> {
  const d = job.data;
  if (!d.packageUrl || !d.sha256Url || !d.commit) throw new StepFailed("the job names no package");
  const pkg = join(work, basename(new URL(d.packageUrl).pathname));
  await download(d.packageUrl, pkg);
  await download(d.sha256Url, `${pkg}.sha256`);
  const want = /^([0-9a-f]{64})(?:\s|$)/.exec(readFileSync(`${pkg}.sha256`, "utf8"))?.[1];
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

// The state as the stopped service left it: what a rollback puts back, so nothing written between the first
// backup and the stop (commands, a rotated or revoked token) is lost.
function snapshotAtStop(job: Job, backupDir: string): string {
  const s = job.data.service;
  const dir = join(backupDir, "at-stop");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (s.db && existsSync(s.db)) backup(s.db, join(dir, "state.db"));
  for (const f of s.files) if (existsSync(f)) copyFileSync(f, join(dir, basename(f)));
  writeFileSync(join(dir, "SHA256SUMS"), readdirSync(dir).filter((f) => f !== "SHA256SUMS").sort().map((f) => `${sha256(join(dir, f))}  ${f}\n`).join(""), { mode: 0o600 });
  job.step(`state at the stop copied to ${dir}`);
  return dir;
}

// The scratch start gets only what it needs to start: no TLS, no tailnet, no admin, input, agents, peers or
// settings, whatever a later release adds. A plain list, so a new switch never reaches the scratch start.
const SCRATCH_KEPT = /^(PATH|HOME|USER|LOGNAME|TMPDIR|LANG|LC_[A-Z]+|FLEET_CONF|FLEET_CONTROL_TOKENS|FLEET_CONTROL_HOST_NAME)$/;
export function scratchEnv(env: Record<string, string>, port: number, db: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (SCRATCH_KEPT.test(k)) out[k] = v;
  return { ...out, PORT: String(port), FLEET_CONTROL_HOST: "127.0.0.1", FLEET_CONTROL_DB: db };
}

// The new code on a scratch loopback port with a copy of the database: it must start and answer.
export async function scratchRun(job: Job, code: string, backupDir: string) {
  const s = job.data.service;
  const port = await freePort();
  // Scratch files live in the job's work folder, which goes when the job ends; the backup stays as it was.
  const work = dirname(dirname(code));
  const scratchDb = join(work, "scratch.db");
  if (s.db && existsSync(join(backupDir, "state.before-upgrade.db"))) copyFileSync(join(backupDir, "state.before-upgrade.db"), scratchDb);
  const env = scratchEnv(s.env, port, s.db ? scratchDb : ":memory:");
  const log = join(work, "scratch.log");
  const fd = openSync(log, "w", 0o600);
  const p = Bun.spawn([process.execPath, "index.ts"], { cwd: code, env, stdio: ["ignore", fd, fd] });
  try {
    const up = await waitHealthy(`http://127.0.0.1:${port}`, s.waits?.scratch ?? 30);
    if (!up) throw new StepFailed(`the new code did not answer on a scratch port: ${readFileSync(log, "utf8").trim().split("\n").slice(-3).join(" | ")}`);
    job.step(`scratch start on 127.0.0.1:${port} answered`);
  } finally {
    p.kill();
    const killer = setTimeout(() => p.kill("SIGKILL"), 10_000);
    await p.exited; clearTimeout(killer); closeSync(fd);
    rmSync(scratchDb, { force: true });
  }
}

// Files fleet sync writes; the old code's sync puts them back, not the copy.
const SYNCED = new Set(["watchdog.sh", "dsh-agent.mjs"]);
const fleetSync = (job: Job, dir: string, what: string) => {
  const s = job.data.service;
  // The service's own environment (on systemd the updater runs with the user manager's).
  const r = run(join(dir, "vendor/agent-fleet/scripts/fleet"), ["sync"], { env: { ...s.env, FLEET_CONF: s.fleetConf } });
  job.step(r.ok ? `${what} fleet sync done` : `${what} fleet sync failed (${r.out}); the watchdog files stay as they were`);
};

export async function swapAndStart(job: Job, code: string, backupDir: string, short: string) {
  const s = job.data.service;
  let next = free(`${s.dir}.new-${short}`);
  try { renameSync(code, next); } catch (e) {
    // The job folder may sit on another file system than the service folder.
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const c = run("cp", ["-a", code, next]);
    if (!c.ok) { rmSync(next, { recursive: true, force: true }); throw new StepFailed(`could not copy the new code beside the service: ${c.out}`); }
  }
  const before = free(`${s.dir}.before-${short}`);
  // null: nothing to put back (the new code never ran); else the copy taken at the stop.
  let restoreFrom: string | null = null;
  let why: string;
  try {
    stopService(s.manager);
    job.step("service stopped");
    if (!(await waitDown(s.health, 15))) throw new StepFailed(`something still answers on ${s.health} after the stop`);
    const snap = snapshotAtStop(job, backupDir);
    renameSync(s.dir, before);
    renameSync(next, s.dir);
    next = "";
    job.step(`folders swapped; the old code is in ${before}`);
    // From here on the new code may write to the database and files.
    restoreFrom = snap;
    fleetSync(job, s.dir, "new");
    await startService(s.manager, s.dir);
    if (await waitHealthy(s.health, s.waits?.start ?? 45)) {
      job.end("done", `the service answers on ${s.health} with release ${short}`);
      return;
    }
    why = `the service did not answer on ${s.health}`;
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  await rollBack(job, before, backupDir, restoreFrom, next, short, why);
}

// Puts the old release back whatever state the swap stopped in, and starts it. Every step is written down,
// so the last line says where the folders are even when the old code does not come up either.
async function rollBack(job: Job, before: string, backupDir: string, restoreFrom: string | null, leftNew: string, short: string, why: string) {
  const s = job.data.service;
  job.step(`${why}; rolling back`);
  const problems: string[] = [];
  let stopped = true;
  try { stopService(s.manager); } catch (e) { stopped = false; problems.push(e instanceof Error ? e.message : String(e)); }
  // Whatever answers after the old start must be the old code, not the new one still shutting down.
  const down = await waitDown(s.health, 15);
  if (!down) job.step(`something still answers on ${s.health}; starting the old code anyway`);
  // The new code's fleet sync ran once restoreFrom was set; the old code's sync puts the watchdog files back
  // whatever happens to the database.
  const newRan = restoreFrom !== null;
  // A process that may still hold the database must not get a file copied under it.
  if (restoreFrom && !(stopped && down)) {
    job.step(`${!stopped ? "the stop reported an error" : "the new code may still be running"}; database and files not put back; the copy is in ${restoreFrom}`);
    problems.push(`database and files not put back, the copy is in ${restoreFrom}`);
    restoreFrom = null;
  } else if (restoreFrom === null) job.step("the new code never ran; database and files left as they are");
  try {
    if (existsSync(before)) {
      if (existsSync(s.dir)) renameSync(s.dir, free(`${s.dir}.failed-${short}`));
      renameSync(before, s.dir);
      job.step("old code back in place");
    } else job.step("the old code never left its folder");
  } catch (e) { problems.push(`folders: ${e instanceof Error ? e.message : e}`); }
  if (leftNew && existsSync(leftNew)) job.step(`the new code was left in ${leftNew}; remove it by hand`);
  if (restoreFrom) {
    if (s.db && existsSync(join(restoreFrom, "state.db"))) {
      try {
        // Copy to a temp file first, then drop the new code's WAL (SQLite would replay it onto the old file),
        // then rename, so a failed copy or a crash halfway never leaves a torn database.
        copyFileSync(join(restoreFrom, "state.db"), `${s.db}.restore-tmp`);
        for (const ext of ["-wal", "-shm"]) rmSync(`${s.db}${ext}`, { force: true });
        renameSync(`${s.db}.restore-tmp`, s.db);
        job.step("database put back as the stopped service left it");
      } catch (e) { rmSync(`${s.db}.restore-tmp`, { force: true }); problems.push(`database: ${e instanceof Error ? e.message : e}`); }
    }
    // Config files go back as they were; the watchdog files come from the old code's fleet sync.
    const restored: string[] = [];
    for (const f of s.files) {
      const copy = join(restoreFrom, basename(f));
      if (SYNCED.has(basename(f)) || !existsSync(copy)) continue;
      try { copyFileSync(copy, f); restored.push(basename(f)); } catch (e) { problems.push(`${basename(f)}: ${e instanceof Error ? e.message : e}`); }
    }
    if (restored.length) job.step(`files put back as the stopped service left them: ${restored.join(", ")}`);
  }
  if (newRan && existsSync(s.dir)) fleetSync(job, s.dir, "old");
  try { await startService(s.manager, s.dir); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
  const back = await waitHealthy(s.health, s.waits?.start ?? 45);
  const where = existsSync(before) ? `the old code is still in ${before}` : `the old code is in ${s.dir}`;
  if (back) job.end("rolled_back", `the old release answers again${problems.length ? ` (${problems.join("; ")})` : ""}`);
  else job.end("failed", `the old release does not answer either (${problems.join("; ") || "see the service log"}); ${where}; backup in ${backupDir}`);
}

// ---- move fleet ------------------------------------------------------------------------------------------

// Copy the fleet folder to the new place, write the new values into the copy's fleet.conf, name it in the
// settings file and restart the service on it. If the service does not come back, the settings file goes back
// as it was and the service starts on the old fleet.conf. The old folder is never changed.
export async function moveFleet(job: Job) {
  const m = job.data.move!;
  const s = job.data.service;
  const oldConf = s.fleetConf;
  const newConf = join(m.to.dir, "fleet.conf");
  // Checked again here: the page's checks are some seconds old by now. The text read here is the one rewritten below.
  const confText = readFileSync(oldConf, "utf8");
  if (createHash("sha256").update(confText).digest("hex") !== m.confSha256) throw new StepFailed(`${oldConf} changed since the move was asked for; nothing moved`);
  const sessions = fleetSessions(m.from.socket, s.env.PATH ?? process.env.PATH ?? "");
  if (sessions.length) throw new StepFailed(`the fleet's tmux server still runs ${sessions.join(", ")}; nothing moved`);
  if (existsSync(m.to.dir)) {
    if (!lstatSync(m.to.dir).isDirectory() || readdirSync(m.to.dir).length) throw new StepFailed(`${m.to.dir} exists and is not empty; nothing moved`);
    rmdirSync(m.to.dir);
  }
  // Copying "<dir>/." takes the files of the folder a symlinked FLEET_DIR names, so the copy is never a link back to it.
  const from = m.from.dir;
  const b = backupState(job, "move");
  mkdirSync(m.to.dir, { recursive: true });
  const r = run("cp", ["-pR", `${from}/.`, m.to.dir]);
  if (!r.ok || !lstatSync(m.to.dir).isDirectory() || !existsSync(newConf) || lstatSync(newConf).isSymbolicLink()) {
    rmSync(m.to.dir, { recursive: true, force: true });
    throw new StepFailed(`copying ${from} to ${m.to.dir} failed${r.ok ? ": the copy has no fleet.conf of its own" : `: ${r.out}`}; nothing moved`);
  }
  // Backups and logs of the old folder stay with it.
  for (const f of readdirSync(m.to.dir)) if (/^fleet\.conf\.bak-|^\.fleet\.conf\./.test(f)) rmSync(join(m.to.dir, f), { force: true });
  // The copy keeps fleet.conf's mode (cp -p), and writing over it keeps the mode too.
  writeFileSync(newConf, movedConf(confText, m.to));
  job.step(`fleet folder copied to ${m.to.dir}; its fleet.conf names fleet ${m.to.fleet}, socket ${m.to.socket}`);
  // The same lock as the page's settings saves, so neither overwrites the other.
  const settingsBefore = withLock(m.settingsFile, () => {
    const before = existsSync(m.settingsFile) ? readFileSync(m.settingsFile, "utf8") : null;
    const saved = before ? JSON.parse(before) as Record<string, unknown> : {};
    writeAtomic(m.settingsFile, `${JSON.stringify({ ...saved, fleetConf: newConf }, null, 2)}\n`);
    return before;
  });
  const written = readFileSync(m.settingsFile, "utf8");
  job.step(`settings file ${m.settingsFile} names ${newConf}`);
  const health = s.health, waits = s.waits ?? { scratch: 30, start: 45 };
  let stoppedAt = Date.now();
  const putBack = async (why: string) => {
    // "put back", "kept" (a page save changed fleetConf meanwhile), "gone" or "locked"; the service is started either way.
    let back: string;
    try { back = withLock(m.settingsFile, () => {
      // A save from the page during the move is kept; only the move's own change is undone.
      const now = existsSync(m.settingsFile) ? readFileSync(m.settingsFile, "utf8") : null;
      if (now !== written) {
        if (now === null) return "gone";
        const cur = JSON.parse(now) as Record<string, unknown>;
        if (cur.fleetConf !== newConf) return "kept";
        const { fleetConf: _drop, ...rest } = cur;
        const prev = settingsBefore ? (JSON.parse(settingsBefore) as Record<string, unknown>).fleetConf : undefined;
        writeAtomic(m.settingsFile, `${JSON.stringify(prev === undefined ? rest : { ...rest, fleetConf: prev }, null, 2)}\n`);
        return "put back";
      }
      if (settingsBefore === null) rmSync(m.settingsFile, { force: true }); else writeAtomic(m.settingsFile, settingsBefore);
      return "put back";
    }); } catch (e) { back = `locked (${e instanceof Error ? e.message : e})`; }
    const said = {
      "put back": `settings file put back, so the service runs ${oldConf} again`,
      kept: "settings file left as the page saved it meanwhile",
      gone: "the settings file is gone, so nothing names the new folder",
    }[back] ?? `the settings file could not be put back: ${back}; it still names ${newConf}, fix it by hand`;
    job.step(`${why}; ${said}`);
    try { stopService(s.manager); } catch {}
    const wentDown = await waitDown(health, 15);
    if (!wentDown) job.step("the service still answers; if the stop did not take, it still runs the old setup");
    const restartAt = Date.now();
    try { await startService(s.manager, s.dir); } catch (e) { job.end("failed", `the old setup did not start either (${e instanceof Error ? e.message : e}); backup in ${b}`); return; }
    const up = await waitHealthy(health, waits.start);
    if (!up) { job.end("failed", `the old setup does not answer on ${health} either; backup in ${b}`); return; }
    // An answer is not enough: a settings file still naming the new folder starts the service there again.
    // A service that never went down wrote its record before the move; take the newest one whose process still lives.
    const ran = wentDown ? runningConf(`${m.settingsFile}.running`, restartAt) : runningConf(`${m.settingsFile}.running`, 0, true);
    if (ran !== oldConf) { job.end("failed", `the service answers on ${health} but runs ${ran ?? "an unknown fleet.conf"}, not the old ${oldConf}; backup in ${b}`); return; }
    job.end("rolled_back", `the service answers again on ${health} with the old fleet; ${m.to.dir} is left for a look`);
  };
  try {
    stopService(s.manager);
    job.step("service stopped");
    stoppedAt = Date.now();
    if (!(await waitDown(health, 15))) { await putBack("the service still answers after the stop"); return; }
    const sync = run(join(s.dir, "vendor/agent-fleet/scripts/fleet"), ["sync"], { env: { ...s.env, FLEET_CONF: newConf } });
    job.step(sync.ok ? "fleet sync done for the new folder" : `fleet sync for the new folder failed (${sync.out})`);
    await startService(s.manager, s.dir);
    job.step("service started");
  } catch (e) { await putBack(`the move stopped: ${e instanceof Error ? e.message : e}`); return; }
  const up = await waitHealthy(health, waits.start);
  if (!up) { await putBack(`the service does not answer on ${health} with the moved fleet`); return; }
  // An answer alone does not say which fleet.conf it took: a settings file it skipped leaves it on the old one.
  const took = runningConf(`${m.settingsFile}.running`, stoppedAt);
  if (took !== newConf) { await putBack(`the service started on ${took ?? "an unknown fleet.conf"}, not ${newConf}`); return; }
  // Absolute symlinks inside the folder still point into the old one; name them so they can be fixed.
  const found = symlinksIn(m.to.dir);
  if (found.links.length) job.step(`symlinks copied as they were (they may point into the old folder): ${found.links.join(", ")}`);
  if (found.problems.length) job.step(`some of the copy could not be listed for symlinks: ${found.problems.join("; ")}`);
  job.end("done", `the service answers on ${health} with fleet ${m.to.fleet} in ${m.to.dir}; the old folder ${m.from.dir} is unchanged (a FLEET_CONTROL_FILE_ROOTS in the plist or unit that names it is not changed)`);
}

// Sessions on the fleet's tmux server. "No server" means none; any other failure (tmux missing, an error) is a refusal,
// so a check that could not run never lets a move through. tmux is looked up the way the lease code does.
export function fleetSessions(socket: string, path: string): string[] {
  const tmux = process.env.FLEET_CONTROL_TMUX ?? Bun.which("tmux", { PATH: [path, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].join(":") });
  if (!tmux) throw new StepFailed("tmux was not found, so the fleet's sessions could not be checked; nothing moved");
  // English messages for NO_SERVER, without touching LC_CTYPE: tmux needs a UTF-8 character locale to run.
  const env: Record<string, string | undefined> = { ...process.env, LC_MESSAGES: "C" };
  if (env.LC_ALL) { env.LC_CTYPE = env.LC_ALL; delete env.LC_ALL; }
  delete env.LANGUAGE;
  const r = spawnSync(tmux, ["-L", socket, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 10_000, env });
  if (r.status === 0) return r.stdout.trim() ? r.stdout.trim().split("\n") : [];
  const err = `${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim();
  if (NO_SERVER.test(err)) return [];
  throw new StepFailed(`the fleet's tmux sessions could not be checked (${err || `exit ${r.status}`}); nothing moved`);
}

// Only a missing server means "no sessions"; a socket that cannot be read (Permission denied) is a failure.
export const NO_SERVER = /no server running on |error connecting to .* \((No such file or directory|Connection refused)\)/;

// Symlinks under dir, relative. Never follows a link, so a loop or a link to / cannot hang or throw; errors are named.
export function symlinksIn(dir: string, cap = 10_000): { links: string[]; problems: string[] } {
  const links: string[] = [], problems: string[] = [];
  const todo = [""];
  let seen = 0;
  while (todo.length) {
    const rel = todo.pop()!;
    let names: string[];
    try { names = readdirSync(join(dir, rel)); } catch (e) { problems.push(`${rel || "."}: ${e instanceof Error ? e.message : e}`); continue; }
    for (const n of names) {
      if (++seen > cap) { problems.push(`stopped after ${cap} entries`); return { links, problems }; }
      const r = rel ? `${rel}/${n}` : n;
      try {
        const st = lstatSync(join(dir, r));
        if (st.isSymbolicLink()) links.push(r); else if (st.isDirectory()) todo.push(r);
      } catch (e) { problems.push(`${r}: ${e instanceof Error ? e.message : e}`); }
    }
  }
  return { links: links.sort(), problems };
}

// The fleet.conf a service started after `since` says it runs; null when there is no such record.
export function runningConf(file: string, since: number, live = false): string | null {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; fleetConf?: unknown; startedAt?: unknown };
    if (typeof r.fleetConf !== "string" || typeof r.startedAt !== "string" || Date.parse(r.startedAt) < since) return null;
    if (live) {
      if (!Number.isInteger(r.pid) || (r.pid as number) <= 0) return null;
      // EPERM: alive, another user's. A reused pid would also read as alive (not ruled out; the record has no process identity).
      try { process.kill(r.pid as number, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return null; }
    }
    return r.fleetConf;
  } catch { return null; }
}

const writeAtomic = (file: string, text: string) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
};

export async function runJob(job: Job) {
  job.data.state = "running";
  job.data.pid = process.pid;
  job.save();
  try {
    if (job.data.action === "move") { await moveFleet(job); return; }
    if (job.data.action === "restart") {
      job.step("restarting the service");
      await restartService(job.data.service.manager, job.data.service.dir);
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
    // Steps before the swap do not stop the service; every step from the stop on ends in swapAndStart.
    if (job.data.state === "running") job.end("failed", `${e instanceof StepFailed ? "" : "error: "}${e instanceof Error ? e.message : e}`);
  } finally {
    // Only this job's lock: a lock another job took after this one was called stale stays.
    const lock = join(dirname(job.file), "lock");
    try { if (readFileSync(lock, "utf8").trim() === job.data.id) rmSync(lock, { force: true }); } catch {}
  }
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file || !existsSync(file) || !statSync(file).isFile()) { console.error("usage: bun scripts/updater.ts <job file>"); process.exit(2); }
  await runJob(Job.read(file));
}
