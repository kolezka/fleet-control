import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Leases } from "../data/leases.ts";
import { leaseUseCases, type LeaseTerminal } from "./leases.ts";
import { Commands } from "../data/commands.ts";
import { Deliverer } from "./delivery.ts";

const op = { name: "web-mariusz", role: "operator" as const };
const other = { name: "dsh-panel", role: "operator" as const };

function setup() {
  let clock = new Date("2026-11-20T10:00:00Z");
  const instances = new Map<string, string | null>([["probe", "$0:100:200"]]);
  const typed: { session: string; text: string }[] = [];
  const terminal: LeaseTerminal = {
    instance: async (s) => instances.get(s) ?? null,
    type: async (session, bytes) => { typed.push({ session, text: new TextDecoder().decode(bytes) }); },
  };
  const leases = new Leases(new Database(":memory:"));
  let n = 0;
  const use = leaseUseCases({ leases, terminal, now: () => clock, newId: () => `lease-${++n}` });
  const ended: string[] = [];
  use.onEnd((l, reason) => ended.push(`${l.id}: ${reason}`));
  const sock = (owner = op.name, session = "probe") => ({ owner, session });
  return { use, leases, typed, instances, ended, sock, tick: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

test("one live lease per session; only the holder's socket types; size and hash are recorded, never the text", async () => {
  const t = setup();
  const lease = await t.use.grant(op, { session: "probe", socketId: "s1", socket: t.sock() });
  expect(lease).toEqual({ id: "lease-1", session: "probe", holder: op.name, grantedAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-11-20T10:05:00.000Z" });
  await expect(t.use.grant(other, { session: "probe", socketId: "s2", socket: t.sock(other.name) })).rejects.toThrow(`probe is held by ${op.name} until 2026-11-20T10:05:00.000Z`);

  await t.use.input("probe", "s1", new TextEncoder().encode("ls\r"));
  await expect(t.use.input("probe", "s2", new TextEncoder().encode("rm\r"))).rejects.toThrow("no input lease for this terminal");
  expect(t.typed).toEqual([{ session: "probe", text: "ls\r" }]);
  const events = t.leases.events("lease-1");
  expect(events.map((e) => [e.kind, e.bytes, e.sha256])).toEqual([["granted", null, null], ["input", 3, createHash("sha256").update("ls\r").digest("hex")]]);
  expect(JSON.stringify(events)).not.toContain("ls\\r");
  await expect(t.use.input("probe", "s1", new Uint8Array(4097))).rejects.toThrow("at most 4096 bytes");
});

test("a lease dies on expiry, on a restarted session and when its socket closes; a reconnect never inherits it", async () => {
  const t = setup();
  await t.use.grant(op, { session: "probe", socketId: "s1", socket: t.sock(), minutes: 1 });
  t.tick(60_000);
  await expect(t.use.input("probe", "s1", new TextEncoder().encode("x"))).rejects.toThrow("no input lease");
  expect(t.ended).toEqual(["lease-1: lease expired"]);

  await t.use.grant(op, { session: "probe", socketId: "s1", socket: t.sock() });
  t.instances.set("probe", "$0:100:999"); // same name, new agent process
  expect((await t.use.sweep()).map((e) => e.reason)).toEqual(["session restarted"]);

  t.instances.set("probe", "$0:100:200");
  await t.use.grant(op, { session: "probe", socketId: "s1", socket: t.sock() });
  t.use.socketClosed("s1");
  // The same person on a new socket starts read-only and must ask again.
  await expect(t.use.input("probe", "s3", new TextEncoder().encode("x"))).rejects.toThrow("no input lease");
  expect(t.ended.slice(2)).toEqual(["lease-3: terminal closed"]);
  expect(t.typed).toEqual([]);
});

test("a lease is granted only to the caller's own open terminal of that session, and only to roles that may type", async () => {
  const t = setup();
  await expect(t.use.grant(op, { session: "probe", socketId: "gone", socket: undefined })).rejects.toThrow("that terminal is not open");
  await expect(t.use.grant(op, { session: "probe", socketId: "s9", socket: t.sock(other.name) })).rejects.toThrow("belongs to another caller");
  await expect(t.use.grant(op, { session: "probe", socketId: "s9", socket: t.sock(op.name, "elsewhere") })).rejects.toThrow("that terminal is not open");
  await expect(t.use.grant({ name: "orch", role: "agent" }, { session: "probe", socketId: "s1", socket: t.sock("orch") })).rejects.toThrow("role agent may not type into a terminal");
  await expect(t.use.grant({ name: "v", role: "viewer" }, { session: "probe", socketId: "s1", socket: t.sock("v") })).rejects.toThrow("role viewer may not type into a terminal");
  await expect(t.use.grant(op, { session: "missing", socketId: "s1", socket: t.sock(op.name, "missing") })).rejects.toThrow("no session missing");
  await expect(t.use.grant(op, { session: "probe", socketId: "s1", socket: t.sock(), minutes: 31 })).rejects.toThrow("from 1 to 30");
  expect(t.use.list()).toEqual([]);
});

test("another operator can revoke with a recorded reason; a restart ends every open lease", async () => {
  const t = setup();
  await t.use.grant(op, { session: "probe", socketId: "s1", socket: t.sock() });
  expect(await t.use.release(other, "probe", "agent stuck, taking over")).toEqual({ ended: true });
  expect(t.ended).toEqual(["lease-1: revoked by dsh-panel: agent stuck, taking over"]);
  expect(await t.use.release(other, "probe")).toEqual({ ended: false });
  await t.use.grant(op, { session: "probe", socketId: "s1", socket: t.sock() });
  expect(t.use.endAfterRestart()).toEqual(["probe"]);
  expect(t.ended.at(-1)).toBe("lease-2: service restarted");
});

test("a queued command waits while the session has a live lease and goes out when the lease ends", async () => {
  const t = setup();
  const commands = new Commands(new Database(":memory:"));
  const sent: string[] = [];
  const deliverer = new Deliverer(commands, async (session) => { sent.push(session); return { exitCode: 0, stdout: `${session}: delivered`, stderr: "" }; }, undefined,
    async (s) => (await t.use.holds(s)) !== null);
  t.use.onEnd((l) => { void deliverer.deliverQueued(l.session); });
  await t.use.grant(op, { session: "probe", socketId: "s1", socket: t.sock() });
  const id = commands.submit({ idempotencyKey: "k1", target: "probe", actor: "orch", text: "hello" }).command.id;
  expect((await deliverer.deliver(id)).status).toBe("queued");
  expect(sent).toEqual([]);
  t.use.socketClosed("s1");
  await Bun.sleep(10);
  expect(sent).toEqual(["probe"]);
  expect(commands.get(id).status).toBe("delivered");
});
