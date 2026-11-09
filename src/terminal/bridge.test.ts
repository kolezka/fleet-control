import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FleetCli } from "../fleet/cli.ts";
import { createTestFleet, type TestFleet } from "../fleet/fixture.ts";
import { serve } from "../server.ts";
import { Store } from "../store.ts";
import { supportsReadOnlyAttach } from "./viewer.ts";

const roBin =
  process.env.READONLY_FLEET_BIN ??
  join(process.env.HOME ?? "", "Development/agent-fleet.worktrees/attach-read-only/scripts/fleet");
const haveRo = (await Bun.file(roBin).exists()) && (await supportsReadOnlyAttach(roBin));

const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (await cond()) return true;
  return false;
};

describe.skipIf(!haveRo)("WebSocket terminal bridge on a private test fleet", () => {
  let fleet: TestFleet;
  let server: ReturnType<typeof serve>;
  let base: URL;
  beforeAll(async () => {
    fleet = await createTestFleet(roBin);
    server = serve({
      fleet: new FleetCli({ fleetBin: roBin, confPath: fleet.confPath }),
      store: new Store(),
      terminal: { fleetBin: roBin, confPath: fleet.confPath },
    }, 0);
    base = new URL(server.url);
  });
  afterAll(async () => {
    server?.stop(true);
    await fleet?.cleanup();
  });

  const wsUrl = (session: string) => `ws://${base.host}/api/sessions/${session}/terminal?cols=80&rows=24`;
  const open = (session: string, origin = base.origin) =>
    new WebSocket(wsUrl(session), { headers: { origin } } as any);

  const pane = async () => (await fleet.tmux("capture-pane", "-p", "-t", fleet.session)).stdout;

  test("streams tokens; any client message (typing or resize) closes the socket and never reaches the pane", async () => {
    const ws = open(fleet.session);
    ws.binaryType = "arraybuffer";
    let out = "";
    const dec = new TextDecoder();
    ws.onmessage = (e) => { out += typeof e.data === "string" ? e.data : dec.decode(e.data as ArrayBuffer, { stream: true }); };
    const closed = new Promise<{ code: number; reason: string }>((r) => { ws.onclose = (e) => r({ code: e.code, reason: e.reason }); });
    await new Promise((r) => { ws.onopen = r; });
    expect(await until(() => fleet.tokens.every((t) => out.includes(t)))).toBe(true);

    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ws.send("echo FCINJECT\r");
    expect((await closed).code).toBe(1008);

    expect(await pane()).not.toContain("FCINJECT");
    expect(await until(async () => (await fleet.tmux("list-clients")).stdout.trim() === "")).toBe(true);
    expect((await fleet.tmux("has-session", "-t", fleet.session)).exitCode).toBe(0);
    const size = await fleet.tmux("display-message", "-p", "-t", fleet.session, "#{window_width}x#{window_height}");
    expect(size.stdout.trim()).toBe("120x30");
  });

  test("cross-origin upgrade is refused before a viewer starts", async () => {
    const res = await fetch(new URL(`/api/sessions/${fleet.session}/terminal`, base), {
      headers: { origin: "http://evil.example", upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    expect(res.status).toBe(403);
    expect((await fleet.tmux("list-clients")).stdout.trim()).toBe("");
  });

  test("a missing session closes the socket with an error code", async () => {
    const ws = open("no-such");
    const code = await new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
    expect(code).not.toBe(1000);
  });
});
