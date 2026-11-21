// Looking after a host's fleet from the page: read and save the hand-written fleet.conf, read the logs,
// restart one fleet.conf session. The host side (files, bash, tmux, the fleet CLI) is injected.
import { createHash } from "node:crypto";
import { AdminError, checkConfEdit, checkRestart, keepsManagedInclude, logQuery, MANAGED_INCLUDE, type LogSource } from "../domain/fleet-admin.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";

// What sourcing a fleet.conf gives: the values the service depends on and the sessions it lists.
export type ConfFacts = { fleet: string; dir: string; socket: string; remote: string; sessions: string[] };

export type FleetHost = {
  path: string;
  read(): Promise<string>;
  // bash -n on the text; the error text, or null when the syntax is fine.
  syntax(text: string): Promise<string | null>;
  // Sources the text in a separate bash with a time limit and reports what it set. Throws on failure.
  facts(text: string): Promise<ConfFacts>;
  // Keeps a copy of the current file, then puts the new text in place in one rename. Returns the copy's path.
  replace(current: string, text: string): Promise<string>;
  log(source: LogSource, lines: number): Promise<string>;
  // Ends the session's tmux session and starts it again from fleet.conf.
  restart(session: string): Promise<{ ok: boolean; output: string }>;
};

export type AdminDeps = { host: FleetHost };

export const revisionOf = (text: string): string => createHash("sha256").update(text).digest("hex");

// One change at a time per process: a save and a restart never interleave.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

export function adminUseCases(deps: AdminDeps, caller?: Caller) {
  const { host } = deps;
  const facts = async (text: string) => {
    try { return await host.facts(text); } catch (e) {
      throw new AdminError("invalid", `fleet.conf does not load: ${e instanceof Error ? e.message : e}`);
    }
  };
  return {
    async conf() {
      requirePermission(caller, "operate");
      const text = await host.read();
      let f: ConfFacts | null = null, loadError: string | null = null;
      try { f = await facts(text); } catch (e) { loadError = e instanceof Error ? e.message : String(e); }
      return { path: host.path, text, revision: revisionOf(text), sessions: f?.sessions ?? [], loadError, managedInclude: MANAGED_INCLUDE };
    },
    async saveConf(input: unknown) {
      requirePermission(caller, "operate");
      const edit = checkConfEdit(input);
      return serial(async () => {
        const current = await host.read();
        if (revisionOf(current) !== edit.revision) throw new AdminError("conflict", "fleet.conf changed on the host since you read it; reload it and edit again");
        if (current === edit.text) return { path: host.path, revision: edit.revision, backup: null, sessions: (await facts(current)).sessions };
        if (!keepsManagedInclude(current, edit.text)) throw new AdminError("invalid", `keep the managed agents line: ${MANAGED_INCLUDE}`);
        const bad = await host.syntax(edit.text);
        if (bad !== null) throw new AdminError("invalid", `bash -n: ${bad}`);
        const [before, after] = [await facts(current).catch(() => null), await facts(edit.text)];
        // The running service, its tmux socket and its agents hang off these; they change only by hand on the host.
        if (before) for (const key of ["fleet", "dir", "socket", "remote"] as const) {
          if (before[key] !== after[key]) {
            const name = { fleet: "FLEET", dir: "FLEET_DIR", socket: "FLEET_TMUX_SOCKET", remote: "REMOTE_SSH" }[key];
            throw new AdminError("invalid", `${name} cannot change from the page (it is ${JSON.stringify(before[key])}); change it on the host and restart the service`);
          }
        }
        const backup = await host.replace(current, edit.text);
        return { path: host.path, revision: revisionOf(edit.text), backup, sessions: after.sessions };
      });
    },
    async log(source: string | null, lines: string | null) {
      requirePermission(caller, "operate");
      const q = logQuery(source, lines);
      return { source: q.source, lines: q.lines, text: await host.log(q.source, q.lines) };
    },
    async restart(session: string, input: unknown) {
      requirePermission(caller, "operate");
      return serial(async () => {
        const f = await facts(await host.read());
        checkRestart(session, input, f.sessions);
        const r = await host.restart(session);
        if (!r.ok) throw new AdminError("unavailable", `${session} did not start again: ${r.output.trim().split("\n").slice(-3).join(" ") || "no output"}`);
        return { session, output: r.output };
      });
    },
  };
}
export type AdminUseCases = ReturnType<typeof adminUseCases>;
