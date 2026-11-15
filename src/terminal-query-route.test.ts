// The terminal also opens at /api/terminal?session=<name>, so a proxy that routes WebSocket
// upgrades by exact path can carry every session. It must keep the checks of the path form.
import { afterAll, expect, test } from "bun:test";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

const fleet = { screen: async () => "", status: async () => ({ raw: "", sessions: [] }) };
const server = serve({ fleet, store: new Store(), terminal: { fleetBin: "/nonexistent/fleet", confPath: "/nonexistent/fleet.conf" } }, 0);
afterAll(() => server.stop(true));

const upgrade = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };
const get = (path: string, headers: Record<string, string>) => fetch(new URL(path, server.url), { headers });

test("query form refuses a foreign page like the path form", async () => {
  for (const path of ["/api/terminal?session=main", "/api/sessions/main/terminal"]) {
    expect((await get(path, { ...upgrade, origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await get(path, upgrade)).status).toBe(403);
  }
});

test("query form refuses a missing or unsafe session name", async () => {
  const origin = server.url.origin;
  for (const path of ["/api/terminal", "/api/terminal?session=", "/api/terminal?session=a%2Fb", "/api/terminal?session=main&cols=0"]) {
    const res = await get(path, { ...upgrade, origin });
    expect(res.status).toBe(400);
    expect((await res.json()).error.kind).toBe("invalid_name");
  }
});

test("query form opens a read-only socket that closes on any client message", async () => {
  const url = new URL("/api/terminal?session=main&cols=80&rows=24", server.url);
  url.protocol = "ws:";
  const closed = await new Promise<number>((resolve) => {
    const ws = new WebSocket(url, { headers: { origin: server.url.origin } } as never);
    ws.onopen = () => ws.send("typed");
    ws.onclose = (e) => resolve(e.code);
  });
  // 1008 when our message arrives first, 1011 when the missing fleet binary fails first. Never open-ended.
  expect([1008, 1011]).toContain(closed);
});
