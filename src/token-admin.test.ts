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
  // rows() (what the page read) still shows two operators; the file under the lock has only b.
  const file: TokenFile = {
    rows: async () => [{ name: "a", role: "operator" }, { name: "b", role: "operator" }],
    change: async (_name, decide) => { decide([{ name: "b", role: "operator" }]); return null; },
  };
  const t = tokenUseCases({ file }, { name: "a", role: "operator" });
  expect((await t.list()).tokens.map((r) => r.name)).toEqual(["a", "b"]);
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

// A stand-in host for the gateway's rotate: it can take the hash and then answer badly.
function fakeHost(behave: (hash: string) => Response | "drop", stagedDir?: () => string) {
  const known = new Set([gw]);
  let current = gw;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (!known.has(token)) return Response.json({ error: { message: "no" } }, { status: 401 });
      const path = new URL(req.url).pathname;
      if (path === "/api/whoami") return Response.json({ principal: "macbook-gateway", role: "operator", auth: true });
      if (path === "/api/token/replace") {
        const { hash } = await req.json() as { hash: string };
        // Take it: the old token stops, the one with this hash starts.
        known.delete(current);
        // The gateway staged the new token beside its config before asking; a real host learns it from the hash.
        if (stagedDir) {
          const d = stagedDir();
          for (const f of readdirSync(d).filter((x) => x.startsWith("token-h.new-"))) {
            const t = readFileSync(join(d, f), "utf8").trim();
            if (require("node:crypto").createHash("sha256").update(t).digest("hex") === hash) { known.add(t); current = t; }
          }
        }
        const r = behave(hash);
        if (r === "drop") { server.stop(true); return new Response(null); }
        return r;
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    },
  });
  return { server, accept: (token: string) => { known.add(token); current = token; } };
}

async function gatewayFor(url: string) {
  const d = join(dir, "gw2");
  require("node:fs").mkdirSync(d, { mode: 0o700 });
  writeFileSync(join(d, "token-h"), `${gw}\n`, { mode: 0o600 });
  const path = join(d, "client.json");
  writeFileSync(path, JSON.stringify({ hosts: [{ id: "h", name: "H", url, tokenFile: "token-h" }] }), { mode: 0o600 });
  const cfg = await loadGatewayConfig(path);
  const g = startGateway(cfg, { port: 0, manage: gatewayHostManager(path, cfg) });
  return { d, g, cfg };
}

test("a host that took the hash and then answered 503 keeps the gateway on the new token", async () => {
  const fake = fakeHost(() => Response.json({ error: { message: "reload failed" } }, { status: 503 }), () => join(dir, "gw2"));
  const { d, g, cfg } = await gatewayFor(fake.server.url.origin);
  try {
    const res = await fetch(`${g.url.origin}/api/manage/h/rotate`, { method: "POST", headers: { origin: g.url.origin, "content-type": "application/json" }, body: JSON.stringify({ confirm: "h" }) });
    expect(res.status).toBe(200);
    const now = readFileSync(join(d, "token-h"), "utf8").trim();
    expect(now).not.toBe(gw);
    expect(cfg.credentials.bearer("h")).toBe(now);
    expect(readdirSync(d).sort()).toEqual(["client.json", "token-h"]);
  } finally {
    g.stop(true); fake.server.stop(true);
  }
});

test("a host that dropped the answer and does not know the new token leaves the old one in place", async () => {
  const fake = fakeHost(() => "drop");
  const { d, g, cfg } = await gatewayFor(fake.server.url.origin);
  try {
    const res = await fetch(`${g.url.origin}/api/manage/h/rotate`, { method: "POST", headers: { origin: g.url.origin, "content-type": "application/json" }, body: JSON.stringify({ confirm: "h" }) });
    expect(res.status).toBe(422);
    // The fake took the hash then vanished: neither token answers, so the staged file is kept and named.
    const msg = (await res.json()).error.message as string;
    expect(msg).toContain("takes neither token now");
    const staged = readdirSync(d).find((f) => f.startsWith("token-h.new-"))!;
    expect(msg).toContain(staged);
    expect(readFileSync(join(d, "token-h"), "utf8").trim()).toBe(gw);
    expect(cfg.credentials.bearer("h")).toBe(gw);
  } finally {
    g.stop(true); fake.server.stop(true);
  }
});

test("token changes by callers who may not operate, from another origin or not as JSON are refused, and the gateway never forwards the own-line routes", async () => {
  const post = (token: string | null, path: string, body: object, headers: Record<string, string> = {}) => fetch(`${host.url.origin}${path}`, {
    method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const before = fileText();
  for (const t of [viewer, agent, managed]) {
    expect((await post(t, "/api/tokens/watcher/revoke", { confirm: "watcher" })).status).toBe(403);
    expect((await post(t, "/api/tokens/watcher/rotate", { confirm: "watcher" })).status).toBe(403);
    expect((await post(t, "/api/token/replace", { hash: "a".repeat(64) })).status).toBe(403);
    expect((await post(t, "/api/token/revoke", { confirm: "x" })).status).toBe(403);
  }
  expect((await post(gw, "/api/tokens/watcher/revoke", { confirm: "watcher" }, { origin: "https://evil.example" })).status).toBe(403);
  const plain = await fetch(`${host.url.origin}/api/tokens/watcher/revoke`, { method: "POST", headers: { authorization: `Bearer ${gw}`, "content-type": "text/plain" }, body: JSON.stringify({ confirm: "watcher" }) });
  expect(plain.status).toBe(415);
  // A hash another line already has is refused and nothing changes.
  const dup = await post(gw, "/api/token/replace", { hash: require("node:crypto").createHash("sha256").update(other).digest("hex") });
  expect(dup.status).toBe(400);
  expect(fileText()).toBe(before);

  // Gateway: /api/manage only from the page's own origin and as JSON; own-line routes are not reachable.
  expect((await fetch(`${gateway.url.origin}/api/manage/h/rotate`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ confirm: "h" }) })).status).toBe(403);
  expect((await fetch(`${gateway.url.origin}/api/manage/h/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "h" }) })).status).toBe(403);
  expect((await fetch(`${gateway.url.origin}/api/manage/h/rotate`, { method: "POST", headers: { origin: gateway.url.origin, "content-type": "text/plain" }, body: JSON.stringify({ confirm: "h" }) })).status).toBe(415);
  expect((await page("/api/hosts/h/token/replace", { hash: "a".repeat(64) })).status).toBe(404);
  expect((await page("/api/hosts/h/token/revoke", { confirm: "macbook-gateway" })).status).toBe(404);
  expect(fileText()).toBe(before);
  expect(await whoami(viewer)).toBe(200);
});

test("two changes at once leave the running service matching the file", async () => {
  // Fire rotate and revoke together; afterwards every line in the file works and nothing else does.
  const [r1, r2] = await Promise.all([
    page("/api/hosts/h/tokens/orchestrator/rotate", { confirm: "orchestrator" }),
    page("/api/hosts/h/tokens/watcher/revoke", { confirm: "watcher" }),
  ]);
  expect([r1.status, r2.status]).toEqual([200, 200]);
  const { token } = await r1.json();
  expect(await whoami(viewer)).toBe(401);
  expect(await whoami(agent)).toBe(401);
  expect(await whoami(token)).toBe(200);
  expect(auth.names().sort()).toEqual([...require("./auth.ts").parseTokens(fileText()).keys()].sort());
});

test("adding and removing hosts at the same time never loses one of the two config changes", async () => {
  const { gatewayHostAdder } = await import("./gateway-enroll.ts");
  writeFileSync(join(dir, "gw", "token-n"), `${newToken()}\n`, { mode: 0o600 });
  const add = gatewayHostAdder(configPath, config);
  const [, removed] = await Promise.all([
    add({ id: "n", name: "N", url: "https://n.example:4871", tokenFile: "token-n" }, newToken()),
    page("/api/manage/h/remove", { confirm: "h", revoke: false }),
  ]);
  expect(removed.status).toBe(200);
  expect(JSON.parse(readFileSync(configPath, "utf8")).hosts.map((h: { id: string }) => h.id)).toEqual(["n"]);
});

test("removing a host closes its open terminal relays", async () => {
  // A host with a terminal socket that stays open.
  const term = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const t = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (new URL(req.url).pathname === "/api/whoami") return Response.json({ principal: "macbook-gateway", role: "operator", auth: true });
      return t === gw && srv.upgrade(req) ? undefined : new Response("no", { status: 401 });
    },
    websocket: { message() {} },
  });
  const { g } = await gatewayFor(term.url.origin);
  try {
    const ws = new WebSocket(`${g.url.origin.replace("http", "ws")}/api/hosts/h/sessions/s/terminal?cols=80&rows=24`, { headers: { origin: g.url.origin } } as never);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
    const res = await fetch(`${g.url.origin}/api/manage/h/remove`, { method: "POST", headers: { origin: g.url.origin, "content-type": "application/json" }, body: JSON.stringify({ confirm: "h", revoke: false }) });
    expect(res.status).toBe(200);
    expect(await Promise.race([closed, Bun.sleep(2000).then(() => -1)])).toBe(1001);
  } finally {
    g.stop(true); term.stop(true);
  }
});

test("the running service takes each change while the tokens file lock is still held, so a slower reload cannot undo a later revoke", async () => {
  const { existsSync } = require("node:fs");
  const { FileAgentTokens } = await import("./agent-tokens.ts");
  const held: boolean[] = [];
  auth.onReplace(() => held.push(existsSync(`${tokensPath}.lock`)));
  expect((await page("/api/hosts/h/tokens/watcher/revoke", { confirm: "watcher" })).status).toBe(200);
  const agents = new FileAgentTokens(tokensPath, auth);
  await agents.issue("fc-new");
  await agents.revoke("fc-new");
  expect(held).toEqual([true, true, true]);
});
