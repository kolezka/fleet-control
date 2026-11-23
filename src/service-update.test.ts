// Restart and update from the page: the release list read from GitHub's API shape, the job written for the
// updater, one job at a time, and every refusal, through a real host service and a real gateway.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, newToken, tokenLine } from "./auth.ts";
import { Store } from "./data/store.ts";
import { serve } from "./server.ts";
import { startGateway, loadGatewayConfig } from "./client-gateway.ts";
import { detectManager, HostUpdates } from "./update-host.ts";
import { checkJobRequest } from "./domain/updates.ts";
import type { JobFile, Manager } from "../scripts/updater.ts";

const op = newToken(), agent = newToken();
const commitNow = "a".repeat(40), commitNew = "b".repeat(40);
let dir: string, host: ReturnType<typeof serve>, gateway: ReturnType<typeof startGateway>, github: ReturnType<typeof Bun.serve>;
let launched: { job: string; manager: Manager | null }[], ghCalls: number, ghStatus: number;
let manager: Manager | null;

const releaseList = () => [
  { tag_name: "v2", draft: false, published_at: "2026-11-23T10:00:00Z", assets: [
    { name: `fleet-control-${commitNew}.tar.gz`, browser_download_url: "https://example.test/v2.tgz" },
    { name: `fleet-control-${commitNew}.tar.gz.sha256`, browser_download_url: "https://example.test/v2.tgz.sha256" },
  ] },
  { tag_name: "v1", draft: false, published_at: "2026-11-22T10:00:00Z", assets: [
    { name: `fleet-control-${commitNow}.tar.gz`, browser_download_url: "https://example.test/v1.tgz" },
    { name: `fleet-control-${commitNow}.tar.gz.sha256`, browser_download_url: "https://example.test/v1.tgz.sha256" },
  ] },
  // No checksum asset, a draft, a bad tag: never offered.
  { tag_name: "v3", draft: false, assets: [{ name: `fleet-control-${"c".repeat(40)}.tar.gz`, browser_download_url: "https://example.test/v3.tgz" }] },
  { tag_name: "v4", draft: true, assets: [] },
  { tag_name: "bad tag", draft: false, assets: [] },
];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "service-update-"));
  launched = []; ghCalls = 0; ghStatus = 200;
  manager = { kind: "launchd", label: "pl.test.fc", plist: join(dir, "x.plist") };
  github = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { ghCalls++; return new URL(req.url).pathname === "/repos/kolezka/fleet-control/releases" ? Response.json(releaseList(), { status: ghStatus }) : new Response("no", { status: 404 }); } });
  const code = join(dir, "service"); mkdirSync(code);
  writeFileSync(join(code, "MANIFEST.json"), JSON.stringify({ commit: commitNow, tag: "v1" }));
  writeFileSync(join(dir, "tokens"), `${tokenLine("op", op, "operator")}\n${tokenLine("worker", agent, "agent")}\n`, { mode: 0o600 });
  const auth = await Auth.fromFile(join(dir, "tokens"));
  const updates = new HostUpdates({
    dir: code, get manager() { return manager; }, db: join(dir, "state.db"), files: [join(dir, "tokens")], fleetConf: join(dir, "fleet.conf"),
    rollbackRoot: dir, jobDir: join(dir, "updates"), health: "http://127.0.0.1:1", api: github.url.origin,
    env: { FLEET_CONF: "/x/fleet.conf", PATH: "/bin", FLEET_CONTROL_TOKENS: join(dir, "tokens"), SECRET_THING: "nope", GITHUB_TOKEN: "nope" },
    launch: (job, m) => { launched.push({ job, manager: m }); },
  });
  host = serve({ fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store: new Store(":memory:"), updates: { host: updates } }, 0, { auth });
  mkdirSync(join(dir, "gw"), { mode: 0o700 });
  writeFileSync(join(dir, "gw", "token-h"), `${op}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "gw", "client.json"), JSON.stringify({ hosts: [{ id: "h", name: "H", url: host.url.origin, tokenFile: "token-h" }] }), { mode: 0o600 });
  gateway = startGateway(await loadGatewayConfig(join(dir, "gw", "client.json")), { port: 0 });
});
afterEach(() => { gateway.stop(true); host.stop(true); github.stop(true); rmSync(dir, { recursive: true, force: true }); });

const page = (path: string, body?: object, headers: Record<string, string> = {}) => fetch(`${gateway.url.origin}/api/hosts/h${path}`, {
  method: body ? "POST" : "GET",
  headers: { origin: gateway.url.origin, ...(body ? { "content-type": "application/json" } : {}), ...headers },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const direct = (path: string, token: string, body?: object) => fetch(`${host.url.origin}/api${path}`, {
  method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, origin: host.url.origin, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
});

test("the page sees the running release and only releases with a package and its checksum", async () => {
  const r = await page("/service");
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.current).toEqual({ commit: commitNow, tag: "v1" });
  expect(body.releases.map((x: { tag: string }) => x.tag)).toEqual(["v2", "v1"]);
  expect(body.releases[0]).toEqual({ tag: "v2", commit: commitNew, publishedAt: "2026-11-23T10:00:00Z", url: "https://example.test/v2.tgz", sha256Url: "https://example.test/v2.tgz.sha256" });
  expect(body.unavailable).toBeNull();
  expect(body.running).toBeNull();
  // The list is cached for a few minutes, so a page polling during an update does not hammer GitHub.
  await page("/service");
  expect(ghCalls).toBe(1);
});

test("an update writes an owner-only job for the updater with the release, the service and only safe environment", async () => {
  const r = await page("/service/update", { tag: "v2", confirm: "v2" });
  expect(r.status).toBe(202);
  const { job } = await r.json();
  expect(job).toMatchObject({ action: "update", tag: "v2", commit: commitNew, by: "op", state: "starting" });
  expect(launched).toHaveLength(1);
  const file = launched[0]!.job;
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const written = JSON.parse(readFileSync(file, "utf8")) as JobFile;
  expect(written.packageUrl).toBe("https://example.test/v2.tgz");
  expect(written.sha256Url).toBe("https://example.test/v2.tgz.sha256");
  expect(written.service.manager).toEqual(manager!);
  expect(Object.keys(written.service.env).sort()).toEqual(["FLEET_CONF", "FLEET_CONTROL_TOKENS", "PATH"]);
  expect(readFileSync(join(dir, "updates", "lock"), "utf8")).toBe(job.id);
  // While it runs, a second job is refused and the page shows the running one.
  const again = await page("/service/restart", { confirm: "restart" });
  expect(again.status).toBe(409);
  expect((await again.json()).error.message).toBe(`another restart or update is running (${job.id}); wait for it to end`);
  expect((await (await page("/service")).json()).running.id).toBe(job.id);
});

test("a lock left by an updater that is gone does not block the next job", async () => {
  const first = await (await page("/service/restart", { confirm: "restart" })).json();
  const file = launched[0]!.job;
  const data = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...data, state: "running", pid: 2 ** 22 + 12345 }));
  const r = await page("/service/restart", { confirm: "restart" });
  expect(r.status).toBe(202);
  expect((await r.json()).job.id).not.toBe(first.job.id);
});

test("refusals: wrong confirm, unknown release, the release already running, other roles, no service manager, a page from elsewhere", async () => {
  const cases: [object, number, string][] = [
    [{ confirm: "yes" }, 400, "type restart to confirm"],
  ];
  for (const [body, status, message] of cases) {
    const r = await page("/service/restart", body);
    expect(r.status).toBe(status);
    expect((await r.json()).error.message).toBe(message);
  }
  const upd: [object, number, string][] = [
    [{ tag: "v2", confirm: "v1" }, 400, "type v2 to confirm"],
    [{ tag: "v9", confirm: "v9" }, 404, "no release v9 with a package"],
    [{ tag: "v3", confirm: "v3" }, 404, "no release v3 with a package"],
    [{ tag: "v1", confirm: "v1" }, 400, `this service already runs v1 (${commitNow.slice(0, 7)})`],
    [{ tag: "v2", confirm: "v2", force: true }, 400, "unknown field force"],
  ];
  for (const [body, status, message] of upd) {
    const r = await page("/service/update", body);
    expect(r.status).toBe(status);
    expect((await r.json()).error.message).toBe(message);
  }
  expect((await direct("/service", agent)).status).toBe(403);
  expect((await direct("/service/restart", agent, { confirm: "restart" })).status).toBe(403);
  const foreign = await fetch(`${host.url.origin}/api/service/restart`, { method: "POST", headers: { authorization: `Bearer ${op}`, origin: "http://evil.example", "content-type": "application/json" }, body: "{\"confirm\":\"restart\"}" });
  expect(foreign.status).toBe(403);
  const plain = await fetch(`${host.url.origin}/api/service/restart`, { method: "POST", headers: { authorization: `Bearer ${op}`, origin: host.url.origin, "content-type": "text/plain" }, body: "{\"confirm\":\"restart\"}" });
  expect(plain.status).toBe(415);
  manager = null;
  const none = await page("/service/restart", { confirm: "restart" });
  expect(none.status).toBe(422);
  expect((await none.json()).error.message).toBe("this service was not started by launchd or systemd, so the page cannot restart or update it");
  expect(launched).toHaveLength(0);
  expect(readdirSync(dir)).not.toContain("updates");
});

test("an updater that does not start leaves no job and no lock, and says so", async () => {
  const failing = new HostUpdates({
    dir: join(dir, "service"), manager, db: null, files: [], fleetConf: join(dir, "fleet.conf"), rollbackRoot: dir, jobDir: join(dir, "updates2"),
    health: "http://127.0.0.1:1", api: github.url.origin, env: {}, launch: () => { throw new Error("systemd-run exited 1"); },
  });
  let message = "";
  try { await failing.start("restart", null, "op"); } catch (e) { message = (e as Error).message; }
  expect(message).toBe("the updater did not start: systemd-run exited 1");
  expect(readdirSync(join(dir, "updates2"))).toEqual([]);
});

test("a GitHub failure leaves restart and the job list working", async () => {
  ghStatus = 500;
  const body = await (await page("/service")).json();
  expect(body.releases).toEqual([]);
  expect(body.releaseError).toBe("GitHub answered 500 for the release list");
  expect((await page("/service/restart", { confirm: "restart" })).status).toBe(202);
});

test("the service manager is found from launchd's label or systemd's cgroup, and not guessed otherwise", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library/LaunchAgents/pl.raqz.fleet-control.plist"), "");
  expect(detectManager({ XPC_SERVICE_NAME: "pl.raqz.fleet-control" }, home)).toEqual({ kind: "launchd", label: "pl.raqz.fleet-control", plist: join(home, "Library/LaunchAgents/pl.raqz.fleet-control.plist") });
  // A terminal on macOS has XPC_SERVICE_NAME=0; that, and any label without a plist, is not a service this can restart.
  expect(detectManager({ XPC_SERVICE_NAME: "0" }, home)).toBeNull();
  expect(detectManager({ XPC_SERVICE_NAME: "other.label" }, home)).toBeNull();
  const cg = join(home, "cgroup");
  writeFileSync(cg, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/fleet-control.service\n");
  expect(detectManager({ INVOCATION_ID: "x" }, home, cg)).toEqual({ kind: "systemd", unit: "fleet-control.service", unitFile: join(home, ".config/systemd/user/fleet-control.service") });
  writeFileSync(cg, "0::/user.slice/user-1000.slice/session-3.scope\n");
  expect(detectManager({ INVOCATION_ID: "x" }, home, cg)).toBeNull();
  expect(detectManager({}, home, cg)).toBeNull();
  rmSync(home, { recursive: true, force: true });
});

test("job requests are checked before anything else", () => {
  expect(checkJobRequest("update", { tag: "v1.2", confirm: "v1.2" })).toEqual({ tag: "v1.2" });
  expect(() => checkJobRequest("update", { tag: "../x", confirm: "../x" })).toThrow("tag must be a release tag");
  expect(() => checkJobRequest("restart", [])).toThrow("body must be an object");
});
