// Restarting and updating the host service from the page. A separate updater process does the work, because
// the service cannot replace or restart itself and still report what happened.
import { AdminError } from "./fleet-admin.ts";

export const RESTART_CONFIRM = "restart";
// Release packages are named after the full commit they were built from.
export const PACKAGE_NAME = /^fleet-control-([0-9a-f]{40})\.tar\.gz$/;
export const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type Release = { tag: string; commit: string; publishedAt: string; url: string; sha256Url: string };

export type JobAction = "restart" | "update";
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
};
export const JOB_ID = /^upd-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
export const JOB_FINAL: readonly JobState[] = ["done", "rolled_back", "failed"];

export const releasePackageOk = (name: string) => PACKAGE_NAME.exec(name)?.[1] ?? null;

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
