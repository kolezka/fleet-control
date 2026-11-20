// Terminal input leases: who may type into which session, through which socket, until when.
// The terminal side (tmux) is injected; this module decides and records, it never touches tmux itself.
import { createHash, randomUUID } from "node:crypto";
import type { Leases } from "../data/leases.ts";
import { LeaseError, leaseDead, leaseMinutes, leaseReason, MAX_INPUT_BYTES, type Lease } from "../domain/leases.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";
import { sessionNamePattern } from "../domain/commands.ts";

export type LeaseTerminal = {
  // Identity of the session's pane and the program running in it now, or null when the session does not exist.
  // Throws when tmux could not be asked: that says nothing about the session, so no lease ends on it.
  instance(session: string): Promise<string | null>;
  // Types the bytes into the session's pane, exactly as given.
  type(session: string, bytes: Uint8Array): Promise<void>;
};

export type LeaseDeps = {
  leases: Leases;
  terminal: LeaseTerminal;
  now?: () => Date;
  newId?: () => string;
};

// Told when a lease ends: the server tells the holder's socket, the delivery queue sends what it held.
export type LeaseEndListener = (lease: Lease, reason: string) => void;

export type LeaseView = { id: string; session: string; holder: string; grantedAt: string; expiresAt: string };
const view = (l: Lease): LeaseView => ({ id: l.id, session: l.session, holder: l.holder, grantedAt: l.grantedAt, expiresAt: l.expiresAt });

export function leaseUseCases(deps: LeaseDeps) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => `lease-${randomUUID()}`);
  const listeners = new Set<LeaseEndListener>();
  const checkSession = (s: string) => { if (!sessionNamePattern.test(s)) throw new LeaseError("invalid", "bad session name"); };

  const end = (l: Lease, reason: string): boolean => {
    const ended = deps.leases.end(l.id, reason, now().toISOString());
    if (ended) for (const f of listeners) {
      try { f(l, reason); } catch (e) { console.error(`lease end listener failed: ${e instanceof Error ? e.message : e}`); }
    }
    return ended;
  };

  // The open lease if it still allows input; a dead one is ended here, so it never blocks the next grant.
  // Expiry needs no tmux, so an expired lease ends even while tmux cannot be asked. A failed probe throws.
  const live = async (session: string): Promise<Lease | null> => {
    const l = deps.leases.open(session);
    if (!l) return null;
    const expired = leaseDead(l, now(), l.instance);
    if (expired) { end(l, expired); return null; }
    const dead = leaseDead(l, now(), await deps.terminal.instance(session));
    if (dead) { end(l, dead); return null; }
    return l;
  };

  return {
    // The socket must belong to the caller: a lease is never granted to someone else's terminal.
    // `socket` is the caller's open terminal for this session as the server knows it, or undefined.
    // `isOpen` is asked again after the last await: a socket that closed meanwhile never gets a lease nothing would end.
    async grant(caller: Caller | undefined, input: { session: string; socketId: string; socket: { owner: string; session: string; isOpen: () => boolean } | undefined; minutes?: unknown; reason?: unknown }): Promise<LeaseView> {
      requirePermission(caller, "input");
      checkSession(input.session);
      const minutes = leaseMinutes(input.minutes);
      const reason = leaseReason(input.reason, "typing from the page");
      if (!input.socket || input.socket.session !== input.session || input.socket.owner !== (caller?.name ?? "local")) {
        throw new LeaseError("invalid", "that terminal is not open, or it belongs to another caller; reopen it and try again");
      }
      const instance = await deps.terminal.instance(input.session);
      if (!instance) throw new LeaseError("not_found", `no session ${input.session}`);
      const held = await live(input.session);
      if (held) throw new LeaseError("conflict", `${input.session} is held by ${held.holder} until ${held.expiresAt}`);
      if (!input.socket.isOpen()) throw new LeaseError("invalid", "that terminal closed; reopen it and try again");
      const at = now();
      return view(deps.leases.grant({
        id: newId(), session: input.session, instance, holder: caller?.name ?? "local",
        socketId: input.socketId, grantedAt: at.toISOString(), expiresAt: new Date(at.getTime() + minutes * 60_000).toISOString(),
      }, reason));
    },

    // Any caller allowed to type may end the lease, its own or another's, with a recorded reason.
    async release(caller: Caller | undefined, session: string, reason?: unknown): Promise<{ ended: boolean }> {
      requirePermission(caller, "input");
      checkSession(session);
      const l = deps.leases.open(session);
      if (!l) return { ended: false };
      const who = caller?.name ?? "local";
      const why = leaseReason(reason, who === l.holder ? "released" : `revoked by ${who}`);
      return { ended: end(l, who === l.holder ? why : `revoked by ${who}: ${why}`) };
    },

    // One terminal message. Only the holder's socket writes, and only while the lease is alive.
    async input(session: string, socketId: string, bytes: Uint8Array): Promise<void> {
      const l = await live(session);
      if (!l || l.socketId !== socketId) throw new LeaseError("gone", "no input lease for this terminal");
      if (bytes.byteLength === 0) return;
      if (bytes.byteLength > MAX_INPUT_BYTES) throw new LeaseError("invalid", `one input message is at most ${MAX_INPUT_BYTES} bytes`);
      await deps.terminal.type(session, bytes);
      deps.leases.recordInput(l.id, bytes.byteLength, createHash("sha256").update(bytes).digest("hex"), now().toISOString());
    },

    // At start: every open lease belonged to a socket of the previous process.
    endAfterRestart(): string[] {
      return deps.leases.openAll().filter((l) => end(l, "service restarted")).map((l) => l.session);
    },

    // The socket closed: its leases end at once.
    socketClosed(socketId: string): void {
      for (const l of deps.leases.openForSocket(socketId)) end(l, "terminal closed");
    },

    // Ends leases that expired, whose session restarted or ended, or whose socket is gone (`socketOpen`
    // false: closed without the close callback). A lease whose session cannot be probed now is left for the next sweep.
    async sweep(socketOpen: (socketId: string) => boolean = () => true): Promise<{ lease: Lease; reason: string }[]> {
      const out: { lease: Lease; reason: string }[] = [];
      for (const l of deps.leases.openAll()) {
        let dead = socketOpen(l.socketId) ? leaseDead(l, now(), l.instance) : "terminal closed";
        if (!dead) {
          try { dead = leaseDead(l, now(), await deps.terminal.instance(l.session)); } catch (e) {
            console.error(`lease check for ${l.session} failed: ${e instanceof Error ? e.message : e}`);
            continue;
          }
        }
        if (dead && end(l, dead)) out.push({ lease: l, reason: dead });
      }
      return out;
    },

    // Whether deliveries to this session must wait. A dead lease does not hold anything; one whose
    // session cannot be probed now still holds, so a paste never lands in what someone may be typing.
    async holds(session: string): Promise<Lease | null> {
      try { return await live(session); } catch { return deps.leases.open(session); }
    },

    list(caller: Caller | undefined): LeaseView[] {
      requirePermission(caller, "input");
      return deps.leases.openAll().map(view);
    },

    onEnd(f: LeaseEndListener): () => void {
      listeners.add(f);
      return () => listeners.delete(f);
    },
  };
}

export type LeaseUseCases = ReturnType<typeof leaseUseCases>;
