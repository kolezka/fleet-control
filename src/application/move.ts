// Move fleet from the page: a new FLEET name, FLEET_DIR and tmux socket. These use cases check who asks, that
// nothing still runs on the old setup, and hand the move to the updater, which restarts the service on it.
import { AdminError } from "../domain/fleet-admin.ts";
import { checkMoveRequest, moveBlockers, movedConf, type MoveFacts, type MoveTarget } from "../domain/move.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";
import { createHash } from "node:crypto";
import type { UpdateJob } from "../domain/updates.ts";
import type { ConfFacts, FleetHost } from "./fleet-admin.ts";
import type { WatchdogHost } from "./watchdog.ts";

export type MoveDeps = {
  host: Pick<FleetHost, "path" | "read" | "facts" | "panes">;
  watchdog: WatchdogHost | null;
  // Managed agents still starting or running, and sessions with a live input lease.
  agents: () => string[];
  leases: () => string[];
  // True when the folder exists and holds anything.
  targetUsed: (dir: string) => Promise<boolean>;
  settingsFile: string | null;
  // Why this service cannot be restarted from the page; null when it can.
  unavailable: () => string | null;
  start: (move: { from: MoveTarget; to: MoveTarget; settingsFile: string; confSha256: string }, by: string) => Promise<UpdateJob>;
};

const target = (f: ConfFacts): MoveTarget => ({ fleet: f.fleet, dir: f.dir, socket: f.socket });

export function moveUseCases(deps: MoveDeps, caller?: Caller) {
  const allow = () => requirePermission(caller, "operate");
  const current = async () => {
    try { return await deps.host.facts(await deps.host.read()); } catch (e) {
      throw new AdminError("failed", `fleet.conf does not load (${e instanceof Error ? e.message : e}); fix it first`);
    }
  };
  const factsFor = async (f: ConfFacts, to?: MoveTarget): Promise<MoveFacts> => {
    const wd = deps.watchdog ? await deps.watchdog.state(target(f)).catch(() => ({ installed: false, running: false, inTmux: null })) : { installed: false, running: false, inTmux: false };
    const names = async (socket: string) => (await deps.host.panes(socket).catch(() => [])).map((p) => p.session);
    return {
      from: target(f), remote: f.remote, agents: deps.agents(), leases: deps.leases(),
      watchdog: { installed: wd.installed, running: wd.running, inTmux: wd.inTmux },
      oldSessions: f.socket ? await names(f.socket) : [],
      newSessions: to && to.socket !== f.socket ? await names(to.socket) : [],
      targetUsed: to ? await deps.targetUsed(to.dir) : false,
      settingsFile: deps.settingsFile !== null,
      confInDir: deps.host.path === `${f.dir}/fleet.conf`,
    };
  };
  return {
    async get() {
      allow();
      const f = await current();
      return { from: target(f), unavailable: deps.unavailable(), blockers: moveBlockers(await factsFor(f)) };
    },
    async move(input: unknown) {
      allow();
      const to = checkMoveRequest(input);
      const why = deps.unavailable();
      if (why) throw new AdminError("failed", why);
      const f = await current();
      if (f.socket === "") throw new AdminError("failed", "this fleet uses tmux's default server; a move would take every session on it along, so move it by hand");
      // The copy's fleet.conf must still load with the new values, the same way agent-fleet loads it.
      const original = await deps.host.read();
      const text = movedConf(original, to);
      const blockers = moveBlockers(await factsFor(f, to), to);
      if (blockers.length) throw new AdminError("failed", `not moved: ${blockers.join("; ")}`);
      try {
        const after = await deps.host.facts(text);
        if (after.fleet !== to.fleet || after.dir !== to.dir || after.socket !== to.socket) throw new Error("it does not set the new name, folder and socket");
      } catch (e) { throw new AdminError("failed", `the moved fleet.conf would not load (${e instanceof Error ? e.message : e}); nothing moved`); }
      // The updater moves only the fleet.conf checked here; an edit in between stops it.
      const confSha256 = createHash("sha256").update(original).digest("hex");
      return { job: await deps.start({ from: target(f), to, settingsFile: deps.settingsFile!, confSha256 }, caller?.name ?? "local") };
    },
  };
}
export type MoveUseCases = ReturnType<typeof moveUseCases>;
