// The host side of restart and update: which service manager runs this service, the release list from
// GitHub, the job files, and starting the updater so it outlives the service.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AdminError } from "./domain/fleet-admin.ts";
import { JOB_FINAL, JOB_ID, PACKAGE_NAME, TAG, type JobAction, type Release, type UpdateJob } from "./domain/updates.ts";
import type { UpdateHost } from "./application/updates.ts";
import type { JobFile, Manager } from "../scripts/updater.ts";

export const REPO = "kolezka/fleet-control";
// Only these reach the job file: paths and switches, never a token.
const ENV_KEPT = /^(FLEET_|PORT$|PATH$|HOME$|USER$|LOGNAME$|TMPDIR$|LANG$|LC_)/;
const RELEASES_CACHE_MS = 5 * 60_000;

// launchd sets XPC_SERVICE_NAME to the job label; systemd puts the service in its own cgroup.
export function detectManager(env: Record<string, string | undefined>, home: string, cgroup = "/proc/self/cgroup"): Manager | null {
  const label = env.XPC_SERVICE_NAME;
  if (label && label !== "0" && /^[A-Za-z0-9._-]+$/.test(label)) {
    const plist = join(home, "Library/LaunchAgents", `${label}.plist`);
    return existsSync(plist) ? { kind: "launchd", label, plist } : null;
  }
  if (env.INVOCATION_ID && existsSync(cgroup)) {
    const unit = /\/([A-Za-z0-9@._-]+\.service)\s*$/.exec(readFileSync(cgroup, "utf8"))?.[1];
    if (unit) return { kind: "systemd", unit, unitFile: join(home, ".config/systemd/user", unit) };
  }
  return null;
}

export type HostUpdatesOptions = {
  dir: string;
  manager: Manager | null;
  db: string | null;
  files: string[];
  fleetConf: string;
  rollbackRoot: string;
  jobDir: string;
  health: string;
  env: Record<string, string | undefined>;
  repo?: string;
  api?: string;
  // Starts `bun scripts/updater.ts <job file>` so it survives the service; tests replace it.
  launch?: (job: string, manager: Manager | null, dir: string) => void;
  now?: () => Date;
};

export class HostUpdates implements UpdateHost {
  #cache: { at: number; releases: Release[] } | null = null;
  constructor(readonly o: HostUpdatesOptions) {}

  current() {
    try {
      const m = JSON.parse(readFileSync(join(this.o.dir, "MANIFEST.json"), "utf8")) as { commit?: unknown; tag?: unknown };
      return { commit: typeof m.commit === "string" ? m.commit : null, tag: typeof m.tag === "string" ? m.tag : null };
    } catch { return { commit: null, tag: null }; }
  }

  unavailable() {
    if (!this.o.manager) return "this service was not started by launchd or systemd, so the page cannot restart or update it";
    return null;
  }

  async releases(): Promise<Release[]> {
    const now = (this.o.now ?? (() => new Date()))().getTime();
    if (this.#cache && now - this.#cache.at < RELEASES_CACHE_MS) return this.#cache.releases;
    const url = `${this.o.api ?? "https://api.github.com"}/repos/${this.o.repo ?? REPO}/releases?per_page=20`;
    let r: Response;
    try { r = await fetch(url, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000) }); } catch (e) {
      throw new Error(`cannot read releases from GitHub: ${e instanceof Error ? e.message : e}`);
    }
    if (!r.ok) throw new Error(`GitHub answered ${r.status} for the release list`);
    const body = await r.json() as unknown;
    if (!Array.isArray(body)) throw new Error("GitHub's release list is not a list");
    const releases: Release[] = [];
    for (const raw of body as Array<Record<string, unknown>>) {
      if (raw.draft === true || typeof raw.tag_name !== "string" || !TAG.test(raw.tag_name)) continue;
      const assets = Array.isArray(raw.assets) ? raw.assets as Array<Record<string, unknown>> : [];
      const pkg = assets.find((a) => typeof a.name === "string" && PACKAGE_NAME.test(a.name));
      if (!pkg) continue;
      const sum = assets.find((a) => a.name === `${pkg.name}.sha256`);
      if (!sum || typeof pkg.browser_download_url !== "string" || typeof sum.browser_download_url !== "string") continue;
      releases.push({ tag: raw.tag_name, commit: PACKAGE_NAME.exec(pkg.name as string)![1]!, publishedAt: String(raw.published_at ?? ""), url: pkg.browser_download_url, sha256Url: sum.browser_download_url });
    }
    this.#cache = { at: now, releases };
    return releases;
  }

  async jobs(): Promise<UpdateJob[]> {
    if (!existsSync(this.o.jobDir)) return [];
    const out: UpdateJob[] = [];
    for (const f of readdirSync(this.o.jobDir)) {
      const id = f.replace(/\.json$/, "");
      if (f === id || !JOB_ID.test(id)) continue;
      try {
        const j = JSON.parse(readFileSync(join(this.o.jobDir, f), "utf8")) as JobFile;
        out.push({ id: j.id, action: j.action, tag: j.tag, commit: j.commit, by: j.by, state: j.state, steps: j.steps, startedAt: j.startedAt, endedAt: j.endedAt });
      } catch {}
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10);
  }

  async start(action: JobAction, release: Release | null, by: string): Promise<UpdateJob> {
    const manager = this.o.manager;
    if (!manager) throw new AdminError("failed", this.unavailable()!);
    mkdirSync(this.o.jobDir, { recursive: true, mode: 0o700 });
    const now = (this.o.now ?? (() => new Date()))();
    const id = `upd-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${crypto.randomUUID().slice(0, 8)}`;
    this.#takeLock(id);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.o.env)) if (v !== undefined && ENV_KEPT.test(k)) env[k] = v;
    const job: JobFile = {
      id, action, tag: release?.tag ?? null, commit: release?.commit ?? null,
      packageUrl: release?.url ?? null, sha256Url: release?.sha256Url ?? null,
      by, state: "starting", steps: [], startedAt: now.toISOString(), endedAt: null, pid: null,
      service: { dir: this.o.dir, manager, db: this.o.db, files: this.o.files, fleetConf: this.o.fleetConf, rollbackRoot: this.o.rollbackRoot, health: this.o.health, env },
    };
    const file = join(this.o.jobDir, `${id}.json`);
    try {
      const fd = openSync(file, "wx", 0o600);
      try { writeSync(fd, `${JSON.stringify(job, null, 2)}\n`); } finally { closeSync(fd); }
      (this.o.launch ?? launchUpdater)(file, manager, this.o.dir);
    } catch (e) {
      rmSync(join(this.o.jobDir, "lock"), { force: true });
      rmSync(file, { force: true });
      throw new AdminError("failed", `the updater did not start: ${e instanceof Error ? e.message : e}`);
    }
    return { id, action, tag: job.tag, commit: job.commit, by, state: "starting", steps: [], startedAt: job.startedAt, endedAt: null };
  }

  // One job at a time. A lock left by a job that ended, or whose updater is gone, does not block.
  #takeLock(id: string) {
    const lock = join(this.o.jobDir, "lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        try { writeSync(fd, id); } finally { closeSync(fd); }
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const holder = readFileSync(lock, "utf8").trim();
        let alive = false;
        try {
          const j = JSON.parse(readFileSync(join(this.o.jobDir, `${holder}.json`), "utf8")) as JobFile;
          if (!JOB_FINAL.includes(j.state)) {
            // A job that has not started its updater yet, or whose updater still runs.
            if (j.pid === null) alive = Date.now() - Date.parse(j.startedAt) < 60_000;
            else { try { process.kill(j.pid, 0); alive = true; } catch {} }
          }
        } catch {}
        if (alive) throw new AdminError("conflict", `another restart or update is running (${holder}); wait for it to end`);
        rmSync(lock, { force: true });
      }
    }
    throw new AdminError("conflict", "could not take the update lock; try again");
  }
}

// The updater must outlive this service: on launchd a detached process group survives bootout; on systemd it
// runs in a transient unit of its own, outside the service's cgroup that a stop kills.
export function launchUpdater(job: string, manager: Manager | null, dir: string) {
  const script = resolve(dir, "scripts/updater.ts");
  const log = openSync(`${job.replace(/\.json$/, "")}.log`, "a", 0o600);
  try {
    if (manager?.kind === "systemd") {
      const unit = `fleet-control-updater-${job.match(/upd-[^/]+(?=\.json$)/)![0].slice(-8)}`;
      const r = Bun.spawnSync(["systemd-run", "--user", `--unit=${unit}`, "--collect", "--quiet", `--working-directory=${dirname(job)}`, process.execPath, script, job], { stdout: log, stderr: log });
      if (r.exitCode !== 0) throw new Error(`systemd-run exited ${r.exitCode}; see ${job.replace(/\.json$/, "")}.log`);
    } else {
      const p = Bun.spawn([process.execPath, script, job], { cwd: dirname(job), stdio: ["ignore", log, log], detached: true });
      p.unref();
    }
  } finally { closeSync(log); }
}
