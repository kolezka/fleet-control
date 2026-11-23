// Restart and update of the host service from the page. The updater process does the work; these use
// cases check who asks and what, and hand a job to it.
import { AdminError } from "../domain/fleet-admin.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";
import { checkJobRequest, JOB_FINAL, type JobAction, type Release, type UpdateJob } from "../domain/updates.ts";

export type UpdateHost = {
  // The commit the running code was built from, and the release tag if it came from one.
  current(): { commit: string | null; tag: string | null };
  // Why this service cannot be restarted or updated from the page; null when it can.
  unavailable(): string | null;
  releases(): Promise<Release[]>;
  jobs(): Promise<UpdateJob[]>;
  // Writes the job and starts the updater. Throws AdminError conflict while another job runs.
  start(action: JobAction, release: Release | null, by: string): Promise<UpdateJob>;
};

export function updateUseCases(deps: { host: UpdateHost }, caller?: Caller) {
  const allow = () => requirePermission(caller, "operate");
  const h = deps.host;
  const ready = () => {
    const why = h.unavailable();
    // A definite "not started", which the gateway relays (it reports 5xx as an unknown outcome).
    if (why) throw new AdminError("failed", why);
  };
  return {
    async get() {
      allow();
      const why = h.unavailable();
      // A failed release list does not hide the jobs or the restart button.
      let releases: Release[] = [], releaseError: string | null = null;
      if (!why) { try { releases = await h.releases(); } catch (e) { releaseError = e instanceof Error ? e.message : String(e); } }
      const jobs = await h.jobs();
      return { current: h.current(), unavailable: why, releases, releaseError, jobs, running: jobs.find((j) => !JOB_FINAL.includes(j.state)) ?? null };
    },
    async restart(input: unknown) {
      allow();
      checkJobRequest("restart", input);
      ready();
      return { job: await h.start("restart", null, caller?.name ?? "local") };
    },
    async update(input: unknown) {
      allow();
      const { tag } = checkJobRequest("update", input);
      ready();
      const release = (await h.releases()).find((r) => r.tag === tag);
      if (!release) throw new AdminError("not_found", `no release ${tag} with a package`);
      if (release.commit === h.current().commit) throw new AdminError("invalid", `this service already runs ${tag} (${release.commit.slice(0, 7)})`);
      return { job: await h.start("update", release, caller?.name ?? "local") };
    },
  };
}
export type UpdateUseCases = ReturnType<typeof updateUseCases>;
