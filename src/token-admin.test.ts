// Tokens from the page, end to end: a real host service on a real tokens file, a real gateway with its
// config and token files on disk, and the page's calls through the gateway.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, newToken, tokenLine } from "./auth.ts";
import { Store } from "./data/store.ts";
import { serve } from "./server.ts";
import { HostTokenFile } from "./token-file.ts";
import { loadGatewayConfig, startGateway, type GatewayConfig } from "./client-gateway.ts";
import { gatewayHostManager } from "./gateway-hosts.ts";
import { tokenUseCases, type TokenFile } from "./application/token-admin.ts";

let dir: string, tokensPath: string, configPath: string, auth: Auth, config: GatewayConfig;
let host: ReturnType<typeof serve>, gateway: ReturnType<typeof startGateway>;
const gw = newToken(), other = newToken(), viewer = newToken(), agent = newToken(), managed = newToken(), second = newToken();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "token-admin-"));
  tokensPath = join(dir, "tokens");
  writeFileSync(tokensPath, [
    "# hand-written",
    tokenLine("macbook-gateway", gw, "operator"),
    tokenLine("dsh-panel", other, "operator"),
    tokenLine("watcher", viewer, "viewer"),
    tokenLine("orchestrator", agent, "agent"),
    tokenLine("fc-run", managed, "agent"),
  ].join("\n") + "\n", { mode: 0o600 });
  auth = await Auth.fromFile(tokensPath);
  const deps = { fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store: new Store(":memory:"), tokens: { file: new HostTokenFile(tokensPath, auth) } };
  host = serve(deps, 0, { auth });
  const gwDir = join(dir, "gw");
  require("node:fs").mkdirSync(gwDir, { mode: 0o700 });
  writeFileSync(join(gwDir, "token-h"), `${gw}\n`, { mode: 0o600 });
  configPath = join(gwDir, "client.json");
  writeFileSync(configPath, JSON.stringify({ hosts: [{ id: "h", name: "H", url: host.url.origin, tokenFile: "token-h" }] }), { mode: 0o640 });
  config = await loadGatewayConfig(configPath, { allowNoHosts: true });
  gateway = startGateway(config, { port: 0, manage: gatewayHostManager(configPath, config) });
});
afterEach(() => {
  gateway?.stop(true);
  host?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const page = (path: string, body?: object) => fetch(`${gateway.url.origin}${path}`, {
  method: body ? "POST" : "GET",
  headers: { origin: gateway.url.origin, ...(body ? { "content-type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const whoami = async (token: string) => (await fetch(`${host.url.origin}/api/whoami`, { headers: { authorization: `Bearer ${token}` } })).status;
const fileText = () => readFileSync(tokensPath, "utf8");

test("the page lists names and roles, never hashes, and marks the gateway's own and managed lines", async () => {
  const res = await page("/api/hosts/h/tokens");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toMatch(/[0-9a-f]{64}/);
  const { tokens } = JSON.parse(text);
  expect(tokens).toEqual([
    { name: "macbook-gateway", role: "operator", self: true, managed: false },
    { name: "dsh-panel", role: "operator", self: false, managed: false },
    { name: "watcher", role: "viewer", self: false, managed: false },
    { name: "orchestrator", role: "agent", self: false, managed: false },
    { name: "fc-run", role: "agent", self: false, managed: true },
  ]);
  // Only an operator reads the list.
  expect((await fetch(`${host.url.origin}/api/tokens`, { headers: { authorization: `Bearer ${viewer}` } })).status).toBe(403);
  expect((await fetch(`${host.url.origin}/api/tokens`, { headers: { authorization: `Bearer ${agent}` } })).status).toBe(403);
});

test("rotate and revoke from the page take effect at once, keep the file's other lines and refuse the unsafe ones", async () => {
  // Typed confirmation.
  let res = await page("/api/hosts/h/tokens/watcher/revoke", { confirm: "nope" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toBe("type watcher to confirm");
  expect(await whoami(viewer)).toBe(200);

  res = await page("/api/hosts/h/tokens/watcher/revoke", { confirm: "watcher" });
  expect(res.status).toBe(200);
  expect(await whoami(viewer)).toBe(401);
  expect(fileText()).not.toContain("watcher");
  expect(fileText()).toContain("# hand-written");
  expect(statSync(tokensPath).mode & 0o777).toBe(0o600);

  // Rotate: the new token is shown once, works at once, the old one stops, the role stays.
  res = await page("/api/hosts/h/tokens/orchestrator/rotate", { confirm: "orchestrator" });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const { token } = await res.json();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await whoami(agent)).toBe(401);
  expect(await whoami(token)).toBe(200);
  expect(fileText()).not.toContain(token);
  expect(fileText()).toMatch(/^orchestrator [0-9a-f]{64} agent$/m);

  // Managed agent lines, the caller's own line and an unknown name are refused.
  res = await page("/api/hosts/h/tokens/fc-run/revoke", { confirm: "fc-run" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toBe("fc-run is a managed agent's token; it ends when the agent stops");
  res = await page("/api/hosts/h/tokens/macbook-gateway/revoke", { confirm: "macbook-gateway" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toContain("is the token you are using now");
  res = await page("/api/hosts/h/tokens/ghost/rotate", { confirm: "ghost" });
  expect(res.status).toBe(404);
  expect(await whoami(managed)).toBe(200);
  expect(await whoami(gw)).toBe(200);

  // The other operator can go, as long as one operator (the gateway) is left.
  res = await page("/api/hosts/h/tokens/dsh-panel/revoke", { confirm: "dsh-panel" });
  expect(res.status).toBe(200);
  expect(await whoami(other)).toBe(401);
});

test("revoking the last operator is refused even when another operator asks", async () => {
  writeFileSync(tokensPath, `${tokenLine("macbook-gateway", gw, "operator")}\n${tokenLine("second", second, "operator")}\n`);
  auth.replace(await Auth.fromFile(tokensPath));
  // second revokes the gateway, then the gateway's line is gone, then second cannot revoke itself (own line).
  const ask = (token: string, path: string, body: object) => fetch(`${host.url.origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await ask(second, "/api/tokens/macbook-gateway/revoke", { confirm: "macbook-gateway" })).status).toBe(200);
  const own = await ask(second, "/api/token/revoke", { confirm: "second" });
  expect(own.status).toBe(400);
  expect((await own.json()).error.message).toBe("second is the last operator on this host; add another before revoking it");
  expect(fileText()).toMatch(/^second /m);
});

test("the gateway rotates its own token for a host: the host gets only the hash, the old token dies", async () => {
  const before = readFileSync(join(dir, "gw", "token-h"), "utf8").trim();
  let res = await page("/api/manage/h/rotate", { confirm: "x" });
  expect(res.status).toBe(400);
  res = await page("/api/manage/h/rotate", { confirm: "h" });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).not.toMatch(/[A-Za-z0-9_-]{43}/);
  expect(JSON.parse(body)).toEqual({ id: "h", principal: "macbook-gateway", rotated: true });
  const after = readFileSync(join(dir, "gw", "token-h"), "utf8").trim();
  expect(after).not.toBe(before);
  expect(statSync(join(dir, "gw", "token-h")).mode & 0o777).toBe(0o600);
  expect(fileText()).not.toContain(after);
  expect(await whoami(before)).toBe(401);
  expect(await whoami(after)).toBe(200);
  // The running gateway uses the new token at once.
  expect((await page("/api/hosts/h/tokens")).status).toBe(200);
  // No staged files left.
  expect(readdirSync(join(dir, "gw")).sort()).toEqual(["client.json", "token-h"]);
});

test("removing a host revokes the gateway's line on it, drops it from the config and the running gateway", async () => {
  let res = await page("/api/manage/h/remove", { confirm: "h" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toBe("revoke must be true or false");
  res = await page("/api/manage/h/remove", { confirm: "h", revoke: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: "h", removed: true, revokedOnHost: true, principal: "macbook-gateway", tokenFileRemoved: true });
  expect(await whoami(gw)).toBe(401);
  expect(fileText()).not.toContain("macbook-gateway");
  expect(JSON.parse(readFileSync(configPath, "utf8")).hosts).toEqual([]);
  expect(statSync(configPath).mode & 0o777).toBe(0o640);
  expect(readdirSync(join(dir, "gw"))).toEqual(["client.json"]);
  expect((await (await page("/api/hosts")).json()).hosts).toEqual([]);
  expect((await page("/api/hosts/h/tokens")).status).toBe(404);
  // The config still loads after the gateway restarts.
  expect((await loadGatewayConfig(configPath, { allowNoHosts: true })).hosts).toEqual([]);
});

test("a host that cannot answer is removed only without revoke, and the answer says its line stays", async () => {
  host.stop(true);
  let res = await page("/api/manage/h/remove", { confirm: "h", revoke: true });
  expect(res.status).toBe(422);
  expect((await res.json()).error.message).toContain("remove it without revoking");
  expect(JSON.parse(readFileSync(configPath, "utf8")).hosts).toHaveLength(1);
  res = await page("/api/manage/h/remove", { confirm: "h", revoke: false });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: "h", removed: true, revokedOnHost: false, principal: null, tokenFileRemoved: true });
});

test("a change is checked against the file as it is under the lock, not the list read before", async () => {
  // A stand-in file whose rows change between the list and the change.
  let rows = [{ name: "a", role: "operator" as const }, { name: "b", role: "operator" as const }];
  const file: TokenFile = {
    rows: async () => rows,
    change: async (_name, decide) => { decide(rows); return null; },
  };
  const t = tokenUseCases({ file }, { name: "a", role: "operator" });
  expect((await t.list()).tokens.map((r) => r.name)).toEqual(["a", "b"]);
  rows = [{ name: "b", role: "operator" }];
  await expect(t.revoke("b", { confirm: "b" })).rejects.toThrow("b is the last operator; add another before revoking it");
  await expect(tokenUseCases({ file }, { name: "v", role: "viewer" }).list()).rejects.toThrow("role viewer may not start or stop agents");
});

test("a rotate the host refuses changes nothing: the staged token is thrown away, the old one keeps working", async () => {
  // Another change holds the tokens file lock, so the host refuses after its wait.
  writeFileSync(`${tokensPath}.lock`, `${process.pid}\n`);
  const res = await page("/api/manage/h/rotate", { confirm: "h" });
  rmSync(`${tokensPath}.lock`);
  expect(res.status).toBe(422);
  expect((await res.json()).error.message).toContain("refused the new token: another change holds");
  expect(readFileSync(join(dir, "gw", "token-h"), "utf8").trim()).toBe(gw);
  expect(readdirSync(join(dir, "gw")).sort()).toEqual(["client.json", "token-h"]);
  expect(await whoami(gw)).toBe(200);
  expect((await page("/api/hosts/h/tokens")).status).toBe(200);
}, 15_000);

test("a host whose token file is not the gateway's own is not rotated from the page", async () => {
  writeFileSync(join(dir, "gw", "shared-token"), `${gw}\n`, { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ hosts: [{ id: "h", name: "H", url: host.url.origin, tokenFile: "shared-token" }] }));
  const res = await page("/api/manage/h/rotate", { confirm: "h" });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toContain("which may be shared with another program");
  expect(await whoami(gw)).toBe(200);
  // Removing it keeps the file it does not own.
  const gone = await page("/api/manage/h/remove", { confirm: "h", revoke: false });
  expect((await gone.json()).tokenFileRemoved).toBe(false);
  expect(readdirSync(join(dir, "gw")).sort()).toEqual(["client.json", "shared-token", "token-h"]);
});
