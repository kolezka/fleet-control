// Rules for looking after a host's fleet from the page: its hand-written fleet.conf, its logs and
// restarting one session. Only an operator may do any of it.
export type AdminErrorKind = "invalid" | "conflict" | "not_found" | "unavailable";
export class AdminError extends Error {
  constructor(readonly kind: AdminErrorKind, message: string) {
    super(message);
  }
}

// fleet.conf is a short bash file; anything this big is a mistake, and it must fit through the gateway.
export const MAX_CONF_BYTES = 32 * 1024;
// What the operator types before a save: the file name, so a stray click cannot overwrite it.
export const CONF_CONFIRM = "fleet.conf";
export const LOG_SOURCES = ["watchdog", "service"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 1000;
// The line agent-fleet needs to load the managed agents; a save may not drop it once it is there.
export const MANAGED_INCLUDE = '[ -f "$FLEET_DIR/fleet-control-agents.conf" ] && . "$FLEET_DIR/fleet-control-agents.conf"';
// Managed agents are started and stopped from the agent list, never restarted as fleet.conf sessions.
export const MANAGED_SESSION = /^fc-/;
const SESSION = /^[A-Za-z0-9._-]{1,64}$/;

export type ConfEdit = { text: string; revision: string };

// Shape checks before anything touches the disk. The bash syntax and the values are checked by the host.
export function checkConfEdit(input: unknown): ConfEdit {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError("invalid", "body must be an object");
  const { text, revision, confirm, ...rest } = input as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) throw new AdminError("invalid", `unknown field ${extra[0]}`);
  if (typeof text !== "string") throw new AdminError("invalid", "text must be a string");
  if (new TextEncoder().encode(text).byteLength > MAX_CONF_BYTES) throw new AdminError("invalid", `fleet.conf may be at most ${MAX_CONF_BYTES} bytes`);
  if (text.includes("\0")) throw new AdminError("invalid", "fleet.conf may not contain a NUL byte");
  if (typeof revision !== "string" || !/^[0-9a-f]{64}$/.test(revision)) throw new AdminError("invalid", "revision must be the SHA-256 the file was read with");
  if (confirm !== CONF_CONFIRM) throw new AdminError("invalid", `type ${CONF_CONFIRM} to confirm the save`);
  return { text, revision };
}

// A save keeps the managed-agents include if the file had it: without it running agents fall out of the fleet.
// Where it was the last line that does anything, it stays last, so nothing after it can reset AGENTS.
export function keepsManagedInclude(before: string, after: string): boolean {
  const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  const [b, a] = [lines(before), lines(after)];
  if (!b.includes(MANAGED_INCLUDE)) return true;
  if (!a.includes(MANAGED_INCLUDE)) return false;
  return b.at(-1) !== MANAGED_INCLUDE || a.at(-1) === MANAGED_INCLUDE;
}

export function logQuery(source: string | null, lines: string | null): { source: LogSource; lines: number } {
  if (source === null || !(LOG_SOURCES as readonly string[]).includes(source)) throw new AdminError("invalid", `source must be one of ${LOG_SOURCES.join(", ")}`);
  if (lines !== null && !/^[1-9][0-9]{0,3}$/.test(lines)) throw new AdminError("invalid", `lines must be between 1 and ${MAX_LOG_LINES}`);
  const n = lines === null ? DEFAULT_LOG_LINES : Number(lines);
  if (n > MAX_LOG_LINES) throw new AdminError("invalid", `lines must be between 1 and ${MAX_LOG_LINES}`);
  return { source: source as LogSource, lines: n };
}

// Restart takes a session from fleet.conf, confirmed by typing its name. Managed agents are refused.
export function checkRestart(session: string, input: unknown, listed: readonly string[]): void {
  if (!SESSION.test(session)) throw new AdminError("invalid", "bad session name");
  if (MANAGED_SESSION.test(session)) throw new AdminError("invalid", `${session} is a managed agent; stop and start it from the agent list`);
  if (!listed.includes(session)) throw new AdminError("not_found", `${session} is not a session in fleet.conf`);
  const confirm = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).confirm : undefined;
  if (confirm !== session) throw new AdminError("invalid", `type ${session} to confirm the restart`);
}
