// Restarting and updating the host service from the page. A separate updater process does the work, because
// the service cannot replace or restart itself and still report what happened.
import { AdminError } from "./fleet-admin.ts";
import type { MoveTarget } from "./move.ts";

export const RESTART_CONFIRM = "restart";
// Release packages are named after the full commit they were built from.
export const PACKAGE_NAME = /^fleet-control-([0-9a-f]{40})\.tar\.gz$/;
export const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type Release = { tag: string; commit: string; publishedAt: string; url: string; sha256Url: string };

export type JobAction = "restart" | "update" | "move";
export type JobState = "starting" | "running" | "done" | "rolled_back" | "failed";
export type UpdateJob = {
  id: string;
  action: JobAction;
  // For an update: the release tag and the commit its package was built from.
  tag: string | null;
  commit: string | null;
  by: string;
  state: JobState;
  // One line per step, in order, as the updater did them.
  steps: string[];
  startedAt: string;
  endedAt: string | null;
  // For a move: where the fleet was and where it goes.
  move?: { from: MoveTarget; to: MoveTarget };
};
export const JOB_ID = /^upd-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
export const JOB_FINAL: readonly JobState[] = ["done", "rolled_back", "failed"];

// How the service is run, so the updater can stop and start it.
export type Manager =
  | { kind: "launchd"; label: string; plist: string }
  | { kind: "systemd"; unit: string; unitFile: string | null }
  // Tests: the service is `bun index.ts` started from the folder, its pid in pidFile. failStartsFile, when it
  // holds a number above 0, makes that many starts fail first (a bootstrap that fails right after a bootout).
  | { kind: "test"; pidFile: string; env: Record<string, string>; log: string; failStartsFile?: string; failStopFile?: string };

// The job file the service writes and the updater works through.
export type JobFile = {
  id: string;
  action: JobAction;
  tag: string | null;
  commit: string | null;
  packageUrl: string | null;
  sha256Url: string | null;
  by: string;
  state: JobState;
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
    // The service's environment: paths and switches, never a token.
    env: Record<string, string>;
    // Seconds to wait for an answer: scratch start, then the real start. Defaults 30 and 45.
    waits?: { scratch: number; start: number };
  };
  // A move: the fleet folder is copied to to.dir, the copy's fleet.conf gets the new values, and the
  // settings file names the new fleet.conf, so the service starts on it.
  move?: { from: MoveTarget; to: MoveTarget; settingsFile: string };
};

// A job that is not final but whose updater is gone: its pid no longer runs, or it never wrote one within a
// minute. `alive(pid)` tells whether a process runs.
export function jobGone(j: Pick<JobFile, "state" | "pid" | "startedAt">, now: number, alive: (pid: number) => boolean): boolean {
  if (JOB_FINAL.includes(j.state)) return false;
  if (j.pid === null) return now - Date.parse(j.startedAt) >= 60_000;
  // An update takes minutes; after two hours a living pid is another process that got the number after a reboot.
  if (now - Date.parse(j.startedAt) >= 2 * 3_600_000) return true;
  return !alive(j.pid);
}

// What the page sent to start a job; refused with the reason the operator reads.
export function checkJobRequest(action: JobAction, input: unknown): { tag: string | null } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError("invalid", "body must be an object");
  const body = input as Record<string, unknown>;
  const allowed = action === "update" ? ["tag", "confirm"] : ["confirm"];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new AdminError("invalid", `unknown field ${k}`);
  if (action === "restart") {
    if (body.confirm !== RESTART_CONFIRM) throw new AdminError("invalid", `type ${RESTART_CONFIRM} to confirm`);
    return { tag: null };
  }
  if (typeof body.tag !== "string" || !TAG.test(body.tag)) throw new AdminError("invalid", "tag must be a release tag");
  if (body.confirm !== body.tag) throw new AdminError("invalid", `type ${body.tag} to confirm`);
  return { tag: body.tag };
}
