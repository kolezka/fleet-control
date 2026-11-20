import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth.ts";
import { enrollUseCases } from "./application/enrollment.ts";
import { loadGatewayConfig, startGateway, type GatewayConfig } from "./client-gateway.ts";
import { reloadTokens } from "./config.ts";
import { Store } from "./data/store.ts";
import { enrollDeps, enrollHandler } from "./gateway-enroll.ts";
import { serve } from "./server.ts";
import { connect, parseArgs } from "../scripts/enroll.ts";

// A real host service with a real tokens file, and a real gateway with a real config file.
// Only the TLS hop is replaced: whoami goes to the plain loopback listener.
let dir: string, configPath: string, hostTokens: string;
let store: Store, auth: Auth, host: ReturnType<typeof serve>, gw: ReturnType<typeof startGateway>, config: GatewayConfig;
const URL_NEW = "https://new-host.tail.ts.net:4871";
const reloads: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gateway-enroll-"));
  hostTokens = join(dir, "host-tokens");
  writeFileSync(hostTokens, "web-mariusz " + "a".repeat(64) + " operator\n", { mode: 0o600 });
  auth = await Auth.fromFile(hostTokens);
  store = new Store(":memory:");
  host = serve({ fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" }, store }, 0, { auth });
  configPath = join(dir, "client.json");
  writeFileSync(join(dir, "token-old"), "old-host-token-0000000000\n", { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ hosts: [{ id: "old", name: "Old", url: "https://old.tail.ts.net:4871", tokenFile: "token-old" }] }), { mode: 0o640 });
  config = await loadGatewayConfig(configPath);
  const deps = enrollDeps(configPath, config, { ssh: false });
  const use = enrollUseCases({ ...deps, whoami: async (url, token) => {
    expect(url).toBe(URL_NEW);
    const r = await fetch(`${host.url}api/whoami`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  } });
  gw = startGateway(config, { port: 0, enroll: enrollHandler(use, () => {}) });
});
afterAll(() => {
  gw.stop(true);
  host.stop(true);
  store.db.close();
  if (dir.startsWith(join(tmpdir(), "gateway-enroll-"))) rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, origin: string | null = gw.url.origin) => fetch(`${gw.url}api/enroll${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
});
const request = { id: "new", name: "New host", url: URL_NEW, mode: "connect", principal: "macbook-gateway", dir: "/srv/fleet-control-service" };

test("the add-host page and API exist only when enrollment is on", async () => {
  const off = startGateway(config, { port: 0 });
  try {
    expect((await fetch(`${off.url}add-host`)).status).toBe(404);
    expect((await fetch(`${off.url}api/enroll`)).status).toBe(404);
    expect((await (await fetch(`${off.url}api/hosts`)).json()).enroll).toBeUndefined();
  } finally { off.stop(true); }
  expect((await fetch(`${gw.url}add-host`)).status).toBe(200);
  expect((await (await fetch(`${gw.url}api/hosts`)).json()).enroll).toBe(true);
});

test("a write without this page's origin is refused before anything is made", async () => {
  for (const origin of [null, "http://evil.example"]) expect((await post("", request, origin)).status).toBe(403);
  expect((await (await fetch(`${gw.url}api/enroll`)).json())).toEqual({ pending: [] });
});

test("connect end to end: token kept here, hash pasted there, host added only after it answers right", async () => {
  const begun = await post("", request);
  expect(begun.status).toBe(201);
  const { pending } = await begun.json();
  const tokenFile = join(dir, "token-new");
  const token = readFileSync(tokenFile, "utf8").trim();
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(pending)).not.toContain(token);
  expect(JSON.stringify(await (await fetch(`${gw.url}api/enroll`)).json())).not.toContain(token);

  // Before the host has the hash, Check says so and adds nothing.
  const early = await (await post("/new/check", {})).json();
  expect(early).toEqual({ added: false, reason: "the host does not know this token yet; run the command there first" });
  expect(config.hosts.map((h) => h.id)).toEqual(["old"]);

  // What the pasted command does on the host: add the hash, then SIGHUP (here: the reload it triggers).
  const argv = pending.command.split(" connect ")[1].split(" ");
  const args = parseArgs(argv, ["principal", "hash", "role"]);
  expect(connect(args, { tokens: hostTokens, pid: 1 }, () => void reloadTokens(auth, hostTokens, (l) => reloads.push(l)))).toMatch(/^Added macbook-gateway \(operator\)/);
  await Bun.sleep(50);
  expect(reloads).toEqual(["tokens reloaded: 2 principal(s)"]);
  expect(readFileSync(hostTokens, "utf8")).not.toContain(token);
  // Pasting twice changes nothing.
  expect(connect(args, { tokens: hostTokens, pid: 1 }, () => {})).toMatch(/already there/);

  const done = await (await post("/new/check", {})).json();
  expect(done).toEqual({ added: true, reason: null });
  expect((await (await fetch(`${gw.url}api/hosts`)).json()).hosts.map((h: { id: string }) => h.id)).toEqual(["old", "new"]);
  expect(config.credentials.bearer("new")).toBe(token);
  expect(JSON.parse(readFileSync(configPath, "utf8")).hosts[1]).toEqual({ id: "new", name: "New host", url: URL_NEW, tokenFile });
  expect(statSync(configPath).mode & 0o777).toBe(0o640);
  // The file still loads, so a restarted gateway keeps the host.
  const again = await loadGatewayConfig(configPath);
  expect(again.hosts.map((h) => h.id)).toEqual(["old", "new"]);
  expect(again.credentials.bearer("new")).toBe(token);
  expect((await (await fetch(`${gw.url}api/enroll`)).json())).toEqual({ pending: [] });
});

test("a used id is refused; cancel removes the token file; bad input is a 400 with a reason", async () => {
  const used = await post("", { ...request, id: "old" });
  expect(used.status).toBe(400);
  expect((await used.json()).error.message).toMatch(/already in use/);
  expect((await post("", { ...request, id: "temp", url: "http://x:1" })).status).toBe(400);
  expect((await post("", { ...request, id: "temp" })).status).toBe(201);
  expect(statSync(join(dir, "token-temp")).isFile()).toBe(true);
  expect(await (await post("/temp/cancel", {})).json()).toEqual({ cancelled: "temp" });
  expect(() => statSync(join(dir, "token-temp"))).toThrow();
  expect((await post("/nope/check", {})).status).toBe(400);
  expect((await post("/../x/check", {})).status).toBe(404);
});

test("a token file left from an earlier attempt is never overwritten", async () => {
  const stale = join(dir, "token-stale");
  writeFileSync(stale, "keep-me-0000000000000000\n");
  chmodSync(stale, 0o600);
  const r = await post("", { ...request, id: "stale" });
  expect(r.status).toBe(409);
  expect(readFileSync(stale, "utf8")).toBe("keep-me-0000000000000000\n");
});
