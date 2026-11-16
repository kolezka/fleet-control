// Runs the DSH panel proxy in front of a real Fleet Control service with auth. A fake DSH
// connection stands in for the DSH login fence.
import { afterAll, expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import { Auth, parseTokens, tokenLine } from "../src/auth.ts";
import { serve } from "../src/server.ts";
import { Store } from "../src/data/store.ts";
// @ts-ignore plain JavaScript module loaded by DSH
import { PANEL_PREFIX, TERMINAL_PATH, readSettings, relaySocket, respond, rewrite } from "./proxy.js";

const token = "panel-token-0123456789";
const fleet = { screen: async () => "", status: async () => ({ raw: "", sessions: [] }) };
const auth = new Auth(parseTokens(tokenLine("dsh-panel", token)));
const service = serve({ fleet, store: new Store(), terminal: { fleetBin: "/nonexistent/fleet", confPath: "/nonexistent/fleet.conf" } }, 0, { auth });
const settings = { upstream: new URL(service.url.origin), token };
let admitted = true;
const connection = { requestRejection: (_req: IncomingMessage) => (admitted ? undefined : 401) };
const dsh = createServer((req, res) => respond(connection, settings, req, res));
dsh.on("upgrade", (req, socket, head) => {
  if (new URL(String(req.url), "http://x").pathname === TERMINAL_PATH) relaySocket(connection, settings, req, socket, head);
  else socket.destroy();
});
await new Promise<void>((resolve) => dsh.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(dsh.address() as { port: number }).port}`;
afterAll(() => { dsh.close(); service.stop(true); });

test("page and API answer below the prefix with the panel principal, assets point back below it", async () => {
  expect((await fetch(base + PANEL_PREFIX, { redirect: "manual" })).headers.get("location")).toBe(PANEL_PREFIX + "/");
  const page = await (await fetch(base + PANEL_PREFIX + "/")).text();
  expect(page).toContain(PANEL_PREFIX + "/_bun/");
  expect(page).not.toMatch(/"\/_bun\//);
  const css = page.match(/href="(\/fleet-control\/_bun\/asset\/[^"]+)"/)?.[1];
  expect(css).toBeDefined();
  expect((await fetch(base + css)).status).toBe(200);
  const who = await (await fetch(base + PANEL_PREFIX + "/api/whoami", { headers: { cookie: "fc_session=other; dsh=secret" } })).json();
  expect(who).toEqual({ principal: "dsh-panel", auth: true });
});

test("the panel offers no sign-in or sign-out of its own", async () => {
  for (const p of ["/login", "/logout", "/api/login"]) expect((await fetch(base + PANEL_PREFIX + p, { method: p === "/login" ? "GET" : "POST" })).status).toBe(404);
});

test("a request DSH refuses never reaches Fleet Control", async () => {
  admitted = false;
  try {
    expect((await fetch(base + PANEL_PREFIX + "/api/whoami")).status).toBe(401);
    const closed = await new Promise<string>((resolve) => {
      const ws = new WebSocket(base.replace("http:", "ws:") + TERMINAL_PATH + "?session=main");
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("refused");
    });
    expect(closed).toBe("refused");
  } finally {
    admitted = true;
  }
});

test("writes from the panel page pass the Fleet Control origin check", async () => {
  const res = await fetch(base + PANEL_PREFIX + "/api/commands", { method: "POST", headers: { origin: "http://dsh.example", "content-type": "application/json" }, body: "{}" });
  // No queue configured: the request got past auth and origin and met the missing store.
  expect(res.status).not.toBe(401);
  expect(res.status).not.toBe(403);
});

test("terminal socket is relayed on the one exact path and stays read-only", async () => {
  const code = await new Promise<number>((resolve) => {
    const ws = new WebSocket(base.replace("http:", "ws:") + TERMINAL_PATH + "?session=main&cols=80&rows=24");
    ws.onopen = () => ws.send("typed");
    ws.onclose = (e) => resolve(e.code);
  });
  expect([1008, 1011]).toContain(code);
});

test("settings refuse plain http off loopback and a missing token", () => {
  expect(readSettings({}).error).toBeDefined();
  expect(readSettings({ FLEET_CONTROL_PANEL_URL: "http://192.168.50.4:4871", FLEET_CONTROL_PANEL_TOKEN_FILE: "/nonexistent" }).error).toMatch(/https/);
  expect(readSettings({ FLEET_CONTROL_PANEL_URL: "https://192.168.50.4:4871", FLEET_CONTROL_PANEL_TOKEN_FILE: "/nonexistent" }).error).toMatch(/could not be read/);
});

test("plugin config wins over the environment", async () => {
  const file = `${process.env.TMPDIR ?? "/tmp"}/fc-panel-token-${process.pid}`;
  await Bun.write(file, token + "\n");
  try {
    const s = readSettings({ FLEET_CONTROL_PANEL_URL: "http://192.168.50.4:4871", FLEET_CONTROL_PANEL_TOKEN_FILE: "/nonexistent" }, { url: "https://192.168.50.4:4871/ignored/path", tokenFile: file });
    expect(s.error).toBeUndefined();
    expect(s.upstream?.href).toBe("https://192.168.50.4:4871/");
    expect(s.token).toBe(token);
    expect(readSettings({}, { url: "https://h.example", tokenFile: file, caFile: "/nonexistent" }).error).toMatch(/could not be read/);
  } finally {
    await Bun.file(file).delete();
  }
});

test("rewrite touches only Bun bundle paths", () => {
  expect(rewrite('<script src="/_bun/client/a.js"></script><a href="./install">')).toBe('<script src="/fleet-control/_bun/client/a.js"></script><a href="./install">');
});
