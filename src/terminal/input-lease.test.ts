import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Auth, COOKIE, newToken, tokenLine } from "../auth.ts";
import { leaseUseCases } from "../application/leases.ts";
import { Leases } from "../data/leases.ts";
import { Store } from "../data/store.ts";
import { createTestFleet, type TestFleet } from "../fleet/fixture.ts";
import { fleetSocket, tmuxLeaseTerminal } from "../fleet/lease-terminal.ts";
import { resolveFleetBin } from "../fleet/path.ts";
import { serve } from "../server.ts";
import { Credentials, startGateway } from "../client-gateway.ts";
import { supportsReadOnlyAttach } from "./viewer.ts";

// Real host service, real tmux, real read-only viewer: typing goes only through the lease holder's socket.
const fleetBin = resolveFleetBin();
const usable = (await Bun.file(fleetBin).exists()) && (await supportsReadOnlyAttach(fleetBin)) && Bun.which("python3") !== null;
if (!usable) console.warn("SKIP input lease test: needs the agent-fleet CLI with attach --read-only, tmux and python3");

const until = async (cond: () => Promise<boolean> | boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await cond()) return true;
  return false;
};

describe.skipIf(!usable)("terminal input lease on a private tmux server", () => {
  let fleet: TestFleet, server: ReturnType<typeof serve>, store: Store;
  const alice = newToken(), viewer = newToken();
  beforeAll(async () => {
    fleet = await createTestFleet(fleetBin);
    // Prints every byte it reads as hex, so control keys can be checked exactly.
    await writeFile(join(fleet.dir, "reader.py"), "import os, tty\ntty.setraw(0)\nwhile True:\n    b = os.read(0, 64)\n    if not b: break\n    os.write(1, ('B=' + b.hex() + '\\r\\n').encode())\n");
    await fleet.tmux("new-session", "-d", "-s", "reader", "-x", "120", "-y", "30", `python3 ${join(fleet.dir, "reader.py")}`);
    const tokens = join(fleet.dir, "tokens");
    await writeFile(tokens, `${tokenLine("alice", alice, "operator")}\n${tokenLine("watcher", viewer, "viewer")}\n`);
    store = new Store(":memory:");
    const input = leaseUseCases({ leases: new Leases(store.db), terminal: tmuxLeaseTerminal(await fleetSocket(fleet.confPath)) });
    server = serve({ fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store, terminal: { fleetBin, confPath: fleet.confPath }, input }, 0, { auth: await Auth.fromFile(tokens) });
  });
  afterAll(async () => {
    server?.stop(true);
    await fleet?.cleanup();
  });

  const pane = async () => (await fleet.tmux("capture-pane", "-p", "-J", "-t", "=reader:")).stdout;
  const origin = () => server.url.origin;
  const open = (token: string) => {
    const ws = new WebSocket(`ws://${server.url.host}/api/sessions/reader/terminal?cols=120&rows=31`, { headers: { origin: origin(), cookie: `${COOKIE}=${token}` } } as never);
    ws.binaryType = "arraybuffer";
    const texts: { type: string; [k: string]: unknown }[] = [];
    ws.onmessage = (e) => { if (typeof e.data === "string") texts.push(JSON.parse(e.data)); };
    const closed = new Promise<{ code: number; reason: string }>((resolve) => { ws.onclose = (e) => resolve({ code: e.code, reason: e.reason }); });
    return { ws, texts, closed, id: async () => { await until(() => texts.some((t) => t.type === "socket")); return texts.find((t) => t.type === "socket")!.id as string; } };
  };
  const lease = (token: string, body: unknown, method = "POST") => fetch(`${server.url}api/sessions/reader/lease`, {
    method, headers: { origin: origin(), "content-type": "application/json", authorization: `Bearer ${token}` }, body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const openLeases = async () => ((await (await fetch(`${server.url}api/leases`, { headers: { authorization: `Bearer ${alice}` } })).json()) as { leases: unknown[] }).leases.length;

  test("keys from the holder's socket reach the pane exactly, with the read-only viewer attached", async () => {
    const a = open(alice);
    const id = await a.id();
    // Without a lease a message closes the socket, as the read-only terminal always did.
    const b = open(alice);
    await b.id();
    b.ws.send("x");
    expect(await b.closed).toEqual({ code: 1008, reason: "read-only terminal: no input lease for this socket" });

    const r = await lease(alice, { socket: id, reason: "test" });
    expect(r.status).toBe(201);
    expect(await until(() => a.texts.some((t) => t.type === "lease" && t.state === "granted"))).toBe(true);
    // tmux refuses send-keys while a read-only client is attached; the paste path must still work.
    expect(await until(async () => /read-only/.test((await fleet.tmux("list-clients", "-F", "#{client_flags}")).stdout))).toBe(true);
    expect((await fleet.tmux("send-keys", "-t", "=reader:", "q")).exitCode).not.toBe(0);
    a.ws.send(new Uint8Array([0x61, 0x03, 0x1b, 0x5b, 0x41, 0x0d]));
    expect(await until(async () => (await pane()).includes("B=61031b5b410d"))).toBe(true);

    // A second lease on the same session is refused while this one lives.
    const c = open(alice);
    const cid = await c.id();
    expect((await lease(alice, { socket: cid })).status).toBe(409);
    c.ws.close();

    // Closing the holder's socket ends the lease within a second; a new socket must ask again.
    a.ws.close();
    await a.closed;
    expect(await until(async () => (await openLeases()) === 0, 1000)).toBe(true);
  });

  test("a viewer cannot take a lease, and a lease names a socket of the caller only", async () => {
    const w = open(viewer);
    const wid = await w.id();
    const r = await lease(viewer, { socket: wid });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { message: string } }).error.message).toBe("role viewer may not type into a terminal");
    // Alice cannot take a lease for the watcher's socket.
    expect((await lease(alice, { socket: wid })).status).toBe(400);
    const cross = await fetch(`${server.url}api/sessions/reader/lease`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json", authorization: `Bearer ${alice}` }, body: JSON.stringify({ socket: wid }) });
    expect(cross.status).toBe(403);
    expect(await openLeases()).toBe(0);
    w.ws.close();
    await w.closed;
  });

  test("through the MacBook gateway: lease, keys and release reach the host, and the pane gets the exact bytes", async () => {
    const gw = startGateway({ hosts: [{ id: "h", name: "H", origin: server.url.origin }], credentials: new Credentials(new Map([["h", alice]])) }, { port: 0 });
    try {
      const page = `http://127.0.0.1:${gw.port}`;
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/api/hosts/h/sessions/reader/terminal?cols=120&rows=31`, { headers: { origin: page } } as never);
      ws.binaryType = "arraybuffer";
      const texts: { type: string; [k: string]: unknown }[] = [];
      ws.onmessage = (e) => { if (typeof e.data === "string") texts.push(JSON.parse(e.data)); };
      const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
      expect(await until(() => texts.some((t) => t.type === "socket"))).toBe(true);
      const id = texts.find((t) => t.type === "socket")!.id as string;
      const call = (method: string, body?: unknown) => fetch(`${page}/api/hosts/h/sessions/reader/lease${method === "DELETE" ? "?reason=done" : ""}`, { method, headers: { origin: page, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect((await call("POST", { socket: id, minutes: 2 })).status).toBe(201);
      ws.send(new Uint8Array([0x67, 0x77, 0x0d]));
      expect(await until(async () => (await pane()).includes("B=67770d"))).toBe(true);
      expect(((await (await fetch(`${page}/api/hosts/h/leases`, { headers: { origin: page } })).json()) as { leases: { holder: string }[] }).leases.map((l) => l.holder)).toEqual(["alice"]);
      expect(await (await call("DELETE")).json()).toEqual({ ended: true });
      ws.send(new Uint8Array([0x7a]));
      expect(await closed).toBe(1008);
    } finally {
      gw.stop(true);
    }
  });

  test("a release tells the socket, and its next message closes it without typing", async () => {
    const a = open(alice);
    const id = await a.id();
    expect((await lease(alice, { socket: id })).status).toBe(201);
    expect(await (await lease(alice, null, "DELETE")).json()).toEqual({ ended: true });
    expect(await until(() => a.texts.some((t) => t.type === "lease" && t.state === "ended" && t.reason === "released"))).toBe(true);
    const before = await pane();
    a.ws.send("zz");
    expect((await a.closed).code).toBe(1008);
    expect(await pane()).toBe(before);
  });
});
