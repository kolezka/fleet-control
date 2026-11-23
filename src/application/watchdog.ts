// Turning agent-fleet's watchdog on and off as a host service from the page. The fleet's values come from
// fleet.conf; the service manager (launchd or systemd) is injected.
import { AdminError } from "../domain/fleet-admin.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";
import { checkWatchdogRequest, type WatchdogState } from "../domain/watchdog.ts";
import type { ConfFacts, FleetHost } from "./fleet-admin.ts";

export type WatchdogFleet = { fleet: string; dir: string; socket: string };
export type WatchdogHost = {
  state(f: WatchdogFleet): Promise<WatchdogState>;
  // Installs and starts the service; throws AdminError with the reason when it cannot.
  start(f: WatchdogFleet): Promise<void>;
  // Stops and removes the service. A service that is not there is fine.
  stop(f: WatchdogFleet): Promise<void>;
};
export type WatchdogDeps = { host: Pick<FleetHost, "read" | "facts">; watchdog: WatchdogHost };

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

export function watchdogUseCases(deps: WatchdogDeps, caller?: Caller) {
  const fleet = async (): Promise<WatchdogFleet> => {
    let f: ConfFacts;
    try { f = await deps.host.facts(await deps.host.read()); } catch (e) {
      throw new AdminError("invalid", `fleet.conf does not load: ${e instanceof Error ? e.message : e}`);
    }
    // The watchdog would run on the remote host; a service here would watch nothing.
    if (f.remote) throw new AdminError("failed", "this fleet runs over REMOTE_SSH; run its watchdog on that host");
    return { fleet: f.fleet, dir: f.dir, socket: f.socket };
  };
  return {
    async get() {
      requirePermission(caller, "operate");
      const f = await fleet();
      return { fleet: f.fleet, ...(await deps.watchdog.state(f)) };
    },
    async set(input: unknown) {
      requirePermission(caller, "operate");
      const { on } = checkWatchdogRequest(input);
      return serial(async () => {
        const f = await fleet();
        const now = await deps.watchdog.state(f);
        if (!now.manager) throw new AdminError("failed", "this host has neither launchd nor systemd, so the page cannot run the watchdog as a service");
        if (on) {
          // Two watchdogs would both nudge and replace the same agents. A hand start right after this check
          // still slips through; the page then shows both (state() reports running and inTmux).
          if (now.inTmux) throw new AdminError("conflict", `a watchdog already runs in tmux session ${f.fleet}-watchdog; stop it with fleet watchdog stop first`);
          if (now.inTmux === null) throw new AdminError("conflict", `cannot tell whether a watchdog runs in tmux (${now.inTmuxError}); turning it on could start a second one`);
          if (!now.running) await deps.watchdog.start(f);
        } else if (now.installed || now.running) {
          await deps.watchdog.stop(f);
        }
        return { fleet: f.fleet, ...(await deps.watchdog.state(f)) };
      });
    },
  };
}
export type WatchdogUseCases = ReturnType<typeof watchdogUseCases>;
