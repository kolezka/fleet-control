// Moving a fleet: new FLEET name, FLEET_DIR and tmux socket. The updater copies the fleet folder, writes the
// three values into the copy's fleet.conf and starts the service on it; the old folder stays as it was.
import { AdminError } from "./fleet-admin.ts";

export const MOVE_CONFIRM = "move";
export type MoveTarget = { fleet: string; dir: string; socket: string };
export type MovePlan = MoveTarget & { from: MoveTarget; conf: string; text: string };

const FLEET = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const DIR = /^\/[A-Za-z0-9._\/-]{1,250}$/;
const SOCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function checkMoveRequest(input: unknown): MoveTarget {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError("invalid", "body must be an object");
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["fleet", "dir", "socket", "confirm"].includes(k)) throw new AdminError("invalid", `unknown field ${k}`);
  const fleet = typeof o.fleet === "string" ? o.fleet.trim() : "";
  const dir = typeof o.dir === "string" ? o.dir.trim().replace(/\/+$/, "") : "";
  const socket = typeof o.socket === "string" ? o.socket.trim() : "";
  if (!FLEET.test(fleet)) throw new AdminError("invalid", "fleet must be a plain name: letters, digits, - and _, up to 32");
  if (!DIR.test(dir) || dir.split("/").some((p) => p === "." || p === "..") || dir.split("/").filter(Boolean).length < 2)
    throw new AdminError("invalid", "folder must be a plain absolute path at least two levels deep, without . or ..");
  if (!SOCKET.test(socket)) throw new AdminError("invalid", "socket must be a plain tmux socket name");
  if (o.confirm !== MOVE_CONFIRM) throw new AdminError("invalid", `type ${MOVE_CONFIRM} to confirm`);
  return { fleet, dir, socket };
}

// fleet.conf with the three values replaced. FLEET= and FLEET_DIR= must each be one plain line of their own
// (agent-fleet's template writes them so); anything cleverer is left for a move by hand.
export function movedConf(text: string, to: MoveTarget): string {
  const lines = text.split("\n");
  const at = (name: string) => lines.flatMap((l, i) => (new RegExp(`^\\s*(export\\s+)?${name}=`).test(l) ? [i] : []));
  const fleet = at("FLEET"), dir = at("FLEET_DIR"), socket = at("FLEET_TMUX_SOCKET");
  if (fleet.length !== 1) throw new AdminError("invalid", `fleet.conf sets FLEET on ${fleet.length} lines; a move needs exactly one FLEET= line`);
  if (dir.length !== 1) throw new AdminError("invalid", `fleet.conf sets FLEET_DIR on ${dir.length} lines; a move needs exactly one FLEET_DIR= line`);
  if (socket.length > 1) throw new AdminError("invalid", `fleet.conf sets FLEET_TMUX_SOCKET on ${socket.length} lines; a move needs at most one`);
  const mentions = lines.filter((l, i) => !fleet.includes(i) && !dir.includes(i) && !socket.includes(i) && /\b(FLEET|FLEET_DIR|FLEET_TMUX_SOCKET)=/.test(l.replace(/#.*$/, "")));
  if (mentions.length) throw new AdminError("invalid", `fleet.conf sets the fleet's name, folder or socket in another way too (${mentions[0]!.trim()}); move it by hand`);
  lines[fleet[0]!] = `FLEET=${to.fleet}`;
  lines[dir[0]!] = `FLEET_DIR=${to.dir}`;
  if (socket.length) lines[socket[0]!] = `FLEET_TMUX_SOCKET=${to.socket}`;
  else lines.splice(dir[0]! + 1, 0, `FLEET_TMUX_SOCKET=${to.socket}`);
  return lines.join("\n");
}

// Why the move cannot start now; empty when it can.
export type MoveFacts = {
  from: MoveTarget;
  remote: string;
  agents: string[]; // managed agents still starting or running
  leases: string[]; // sessions with a live input lease
  watchdog: { installed: boolean; running: boolean; inTmux: boolean | null };
  oldSessions: string[]; // sessions on the fleet's current tmux server
  newSessions: string[]; // sessions already on the target tmux server
  targetUsed: boolean; // the target folder exists and is not empty
  settingsFile: boolean;
};
export function moveBlockers(f: MoveFacts, to?: MoveTarget): string[] {
  const out: string[] = [];
  if (f.remote) out.push("this fleet runs over REMOTE_SSH; move it on that host");
  if (!f.settingsFile) out.push("this host has no settings file (FLEET_CONTROL_TOKENS or FLEET_CONTROL_SETTINGS), which keeps the new fleet.conf path");
  if (f.agents.length) out.push(`stop the managed agents first: ${f.agents.join(", ")}`);
  if (f.leases.length) out.push(`end the typing in ${f.leases.join(", ")} first`);
  if (f.watchdog.installed || f.watchdog.running) out.push("turn the watchdog service off first; it runs for the old folder");
  if (f.watchdog.inTmux !== false) out.push(f.watchdog.inTmux ? "stop the watchdog that runs by hand in tmux first (fleet watchdog stop)" : "cannot tell whether a watchdog runs by hand in tmux; fix tmux first");
  if (to) {
    if (to.fleet === f.from.fleet && to.dir === f.from.dir && to.socket === f.from.socket) out.push("nothing to move: the name, folder and socket are the ones in use");
    if (to.dir === f.from.dir && (to.fleet !== f.from.fleet || to.socket !== f.from.socket)) out.push("a move needs a new folder; the name and socket change only together with it");
    if (to.dir !== f.from.dir && (to.dir.startsWith(`${f.from.dir}/`) || f.from.dir.startsWith(`${to.dir}/`))) out.push("the new folder must not be inside the old one, nor the old inside the new");
    if (f.targetUsed) out.push(`${to.dir} exists and is not empty; choose a new folder`);
    if (to.socket !== f.from.socket && f.oldSessions.length) out.push(`end the sessions on the old tmux server first (${f.oldSessions.join(", ")}); the moved fleet uses a new one`);
    if (to.socket !== f.from.socket && f.newSessions.length) out.push(`tmux server ${to.socket} already runs ${f.newSessions.join(", ")}; choose another socket`);
  }
  return out;
}
