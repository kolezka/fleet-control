// Terminal input lease: one writer per session, bound to one terminal socket and one session instance.
// See docs/input-lease-design.md. Input content is never stored, only its size and SHA-256.

export type Lease = {
  id: string;
  session: string;
  instance: string; // `#{session_id}:#{session_created}:#{pane_pid}` (active pane) at grant time
  holder: string; // principal name
  socketId: string; // the one terminal socket allowed to write
  grantedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
};

export type LeaseEventKind = "granted" | "input" | "ended";
export type LeaseEvent = { seq: number; leaseId: string; kind: LeaseEventKind; bytes: number | null; sha256: string | null; detail: string; at: string };

export class LeaseError extends Error {
  constructor(readonly kind: "invalid" | "conflict" | "not_found" | "gone", message: string) {
    super(message);
  }
}

export const DEFAULT_LEASE_MINUTES = 5;
export const MAX_LEASE_MINUTES = 30;
// One terminal message. A paste larger than this is refused, not split.
export const MAX_INPUT_BYTES = 4096;
export const MAX_REASON = 200;

export function leaseMinutes(value: unknown): number {
  if (value === undefined) return DEFAULT_LEASE_MINUTES;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LEASE_MINUTES) {
    throw new LeaseError("invalid", `minutes must be a whole number from 1 to ${MAX_LEASE_MINUTES}`);
  }
  return value as number;
}

export function leaseReason(value: unknown, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value)) throw new LeaseError("invalid", "reason must be plain text");
  const r = value.trim();
  if (r.length > MAX_REASON) throw new LeaseError("invalid", `reason is longer than ${MAX_REASON} characters`);
  return r || fallback;
}

// Why an active lease no longer allows input, or null while it does.
export function leaseDead(lease: Lease, now: Date, instance: string | null): string | null {
  if (lease.endedAt) return lease.endReason ?? "ended";
  if (now.getTime() >= Date.parse(lease.expiresAt)) return "lease expired";
  if (instance === null) return "session ended";
  const [was, wasRunning] = splitInstance(lease.instance);
  const [is, isRunning] = splitInstance(instance);
  if (is !== was) return "session restarted";
  // Something ran in the pane at grant and now only a shell does: the agent exited and keys would go to the
  // shell. A pane that was a shell at grant stays leased while the holder runs commands in it.
  if (wasRunning === "app" && isRunning === "shell") return "the agent exited; the pane is at a shell prompt";
  return null;
}

// "<session id>:<created>:<pane pid>[:shell|app]"; the last part is optional for leases stored before it.
function splitInstance(i: string): [string, string] {
  const m = /^(.*):(shell|app)$/.exec(i);
  return m ? [m[1]!, m[2]!] : [i, ""];
}
