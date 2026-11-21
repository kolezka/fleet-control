// Looking after a host's fleet from the page: read and save the hand-written fleet.conf, read the logs,
// restart one fleet.conf session. The host side (files, bash, tmux, the fleet CLI) is injected.
import { createHash } from "node:crypto";
import { AdminError, checkConfEdit, checkRestart, keepsManagedInclude, logQuery, MANAGED_INCLUDE, MANAGED_SESSION, type LogSource } from "../domain/fleet-admin.ts";
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
  // Ends the session on the fleet's tmux socket and starts it again from fleet.conf.
  restart(session: string, socket: string): Promise<{ ok: boolean; output: string }>;
};

export type AdminDeps = { host: FleetHost };

// Empty means tmux's default server; otherwise a plain name, as src/fleet/lease-terminal.ts accepts.
const PLAIN_SOCKET = /^(|[A-Za-z0-9._-]{1,64})$/;

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
        if (current === edit.text) return { path: host.path, revision: edit.revision, backup: null, sessions: (await host.facts(current).catch(() => null))?.sessions ?? [] };
        if (!keepsManagedInclude(current, edit.text)) throw new AdminError("invalid", `keep the managed agents line, as the last line: ${MANAGED_INCLUDE}`);
        const bad = await host.syntax(edit.text);
        if (bad !== null) throw new AdminError("invalid", `bash -n: ${bad}`);
        // Without the current values nothing can be compared, so a broken file is fixed on the host, not here.
        let before: ConfFacts;
        try { before = await host.facts(current); } catch (e) {
          throw new AdminError("invalid", `the current fleet.conf does not load (${e instanceof Error ? e.message : e}); fix it on the host`);
        }
        const after = await facts(edit.text);
        // Managed agents come from the include line; an edit that loses one (AGENTS reset after the line, say) is refused.
        const lost = before.sessions.filter((s) => MANAGED_SESSION.test(s) && !after.sessions.includes(s));
        if (lost.length) throw new AdminError("invalid", `this edit drops the managed agents ${lost.join(", ")}; keep the managed agents line last and do not reset AGENTS after it`);
        // The running service, its tmux socket and its agents hang off these; they change only by hand on the host.
        for (const key of ["fleet", "dir", "socket", "remote"] as const) {
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
        // A REMOTE_SSH fleet runs its sessions elsewhere: the kill here would miss and the start there would be a no-op.
        if (f.remote) throw new AdminError("unavailable", "this fleet runs over REMOTE_SSH; restart its sessions on that host");
        if (!PLAIN_SOCKET.test(f.socket)) throw new AdminError("unavailable", `fleet.conf names a tmux socket the page does not use: ${JSON.stringify(f.socket)}`);
        const r = await host.restart(session, f.socket);
        if (!r.ok) throw new AdminError("failed", `the old ${session} session ended, and it did not start again: ${r.output.trim().split("\n").slice(-3).join(" ") || "no output"}`);
        return { session, output: r.output };
      });
    },
  };
}
export type AdminUseCases = ReturnType<typeof adminUseCases>;
