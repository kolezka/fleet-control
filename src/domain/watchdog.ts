// Rules for running agent-fleet's watchdog as a service of the host (launchd or systemd) from the page.
import { AdminError } from "./fleet-admin.ts";

// What the operator types before turning the watchdog on or off.
export const WATCHDOG_CONFIRM = "watchdog";
const FLEET_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export type WatchdogState = {
  // launchd or systemd; null where the host has neither (the page cannot run it as a service).
  manager: "launchd" | "systemd" | null;
  // The launchd label or systemd unit this fleet's watchdog gets.
  name: string;
  installed: boolean;
  running: boolean;
  pid: number | null;
  // A watchdog started by hand with `fleet watchdog start`, in tmux session <FLEET>-watchdog.
  // null: tmux could not be asked; inTmuxError says why. Turning on is then refused, turning off is not.
  inTmux: boolean | null;
  inTmuxError?: string;
};

export function checkWatchdogRequest(input: unknown): { on: boolean } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError("invalid", "body must be an object");
  const body = input as Record<string, unknown>;
  for (const k of Object.keys(body)) if (k !== "on" && k !== "confirm") throw new AdminError("invalid", `unknown field ${k}`);
  if (typeof body.on !== "boolean") throw new AdminError("invalid", "on must be true or false");
  if (body.confirm !== WATCHDOG_CONFIRM) throw new AdminError("invalid", `type ${WATCHDOG_CONFIRM} to confirm`);
  return { on: body.on };
}

// One watchdog service per fleet, named after FLEET so two fleets on one host do not share it.
export function watchdogName(manager: "launchd" | "systemd", fleet: string): string {
  if (!FLEET_NAME.test(fleet)) throw new AdminError("invalid", `FLEET ${JSON.stringify(fleet)} cannot name a service`);
  return manager === "launchd" ? `pl.raqz.fleet-watchdog.${fleet}` : `fleet-watchdog-${fleet}.service`;
}
