import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, newToken, tokenLine } from "../auth.ts";
import { Store } from "../data/store.ts";
import { createTestFleet, type TestFleet } from "./fixture.ts";
import { FleetAdminHost } from "./admin.ts";
import { findBash, launchdPlist, managerOf, systemdUnit, WatchdogService } from "./watchdog-service.ts";
import { resolveFleetBin } from "./path.ts";
import { serve } from "../server.ts";
import { Credentials, startGateway } from "../client-gateway.ts";
import { watchdogUseCases, type WatchdogHost } from "../application/watchdog.ts";
import { checkWatchdogRequest, watchdogName } from "../domain/watchdog.ts";

// The real watchdog.sh of the pinned agent-fleet, run by a stand-in launchctl that starts what the plist
// names, the way launchd would. No real launchd or systemd job is created.
const fleetBin = resolveFleetBin();
const bash = await findBash();
const usable = (await Bun.file(fleetBin).exists()) && Bun.which("tmux") !== null && bash !== null;
if (!usable) console.warn("SKIP watchdog service test: needs the agent-fleet CLI, tmux and bash 4+");

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("watchdog rules", () => {
  test("a request names on or off and types watchdog", () => {
    expect(checkWatchdogRequest({ on: true, confirm: "watchdog" })).toEqual({ on: true });
    expect(() => checkWatchdogRequest({ on: true })).toThrow("type watchdog to confirm");
    expect(() => checkWatchdogRequest({ on: "yes", confirm: "watchdog" })).toThrow("on must be true or false");
    expect(() => checkWatchdogRequest({ on: false, confirm: "watchdog", x: 1 })).toThrow("unknown field x");
    expect(() => checkWatchdogRequest([])).toThrow("body must be an object");
    expect(watchdogName("launchd", "fctrl-test")).toBe("pl.raqz.fleet-watchdog.fctrl-test");
    expect(watchdogName("systemd", "fctrl-test")).toBe("fleet-watchdog-fctrl-test.service");
    expect(() => watchdogName("systemd", "a b")).toThrow("cannot name a service");
    expect(managerOf("darwin", {})).toBe("launchd");
    expect(managerOf("linux", { XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("systemd");
    expect(managerOf("linux", {})).toBeNull();
  });

  test("the service files run watchdog.sh from FLEET_DIR with bash 4 and keep agents alive on stop", () => {
    const f = { fleet: "t", dir: "/home/x/fleet 100%", socket: "fleet-t" };
    const unit = systemdUnit(f, "/usr/bin/bash", "/usr/bin:/bin");
    expect(unit).toContain('ExecStart="/usr/bin/bash" "/home/x/fleet 100%%/watchdog.sh" --quiet-start');
    expect(unit).toContain("WorkingDirectory=/home/x/fleet 100%%");
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(() => systemdUnit({ ...f, dir: "/a\nb" }, "/usr/bin/bash", "/bin")).toThrow("control characters");
    const plist = launchdPlist("pl.raqz.fleet-watchdog.t", { ...f, dir: "/Users/x/a&b" }, "/opt/homebrew/bin/bash", "/bin");
    expect(plist).toContain("<string>/opt/homebrew/bin/bash</string><string>/Users/x/a&amp;b/watchdog.sh</string><string>--quiet-start</string>");
    expect(plist).toContain("<key>AbandonProcessGroup</key><true/>");
  });

  test("the use cases need an operator, refuse a second watchdog and a REMOTE_SSH fleet, and do nothing twice", async () => {
    const calls: string[] = [];
    let running = false, inTmux = false, remote = "";
    const wd: WatchdogHost = {
      state: async () => ({ manager: "launchd", name: "w", installed: running, running, pid: running ? 1 : null, inTmux }),
      start: async () => { calls.push("start"); running = true; },
      stop: async () => { calls.push("stop"); running = false; },
    };
    const host = { read: async () => "", facts: async () => ({ fleet: "t", dir: "/d", socket: "fleet-t", remote, sessions: [] }) };
    const op = watchdogUseCases({ host, watchdog: wd }, { name: "op", role: "operator" });
    expect(() => watchdogUseCases({ host, watchdog: wd }, { name: "w", role: "agent" }).get()).toThrow("role agent may not start or stop agents");
    await expect(op.set({ on: true })).rejects.toThrow("type watchdog to confirm");
    expect((await op.set({ on: true, confirm: "watchdog" })).running).toBe(true);
    await op.set({ on: true, confirm: "watchdog" });
    expect(calls).toEqual(["start"]);
    await op.set({ on: false, confirm: "watchdog" });
    await op.set({ on: false, confirm: "watchdog" });
    expect(calls).toEqual(["start", "stop"]);
    inTmux = true;
    await expect(op.set({ on: true, confirm: "watchdog" })).rejects.toThrow("a watchdog already runs in tmux session t-watchdog; stop it with fleet watchdog stop first");
    inTmux = false; remote = "ssh x";
    await expect(op.get()).rejects.toThrow("this fleet runs over REMOTE_SSH; run its watchdog on that host");
    expect(calls).toEqual(["start", "stop"]);
  });
});

describe.skipIf(!usable)("the watchdog as a service of a private fleet", () => {
  let fleet: TestFleet, home: string, server: ReturnType<typeof serve>, gateway: ReturnType<typeof startGateway>;
  const op = newToken();
  // Stand-in launchctl: bootstrap starts the plist's ProgramArguments in the background, print shows its pid,
  // bootout ends it. Each call is recorded.
  const launchctl = () => join(home, "launchctl");
  beforeAll(async () => {
    fleet = await createTestFleet(fleetBin);
    home = await mkdtemp(join(tmpdir(), "fleet-control-wd-home-"));
    await writeFile(launchctl(), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, openSync } from "node:fs";
import { dirname } from "node:path";
const home = ${JSON.stringify("HOME_DIR")};
const [cmd, , file] = process.argv.slice(2);
appendFileSync(home + "/calls", process.argv.slice(2).join(" ") + "\\n");
const pidf = home + "/job.pid";
const alive = () => { if (!existsSync(pidf)) return false; try { process.kill(Number(readFileSync(pidf, "utf8")), 0); return true; } catch { return false; } };
const un = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
if (cmd === "bootstrap") {
  if (alive()) { console.error("already loaded"); process.exit(5); }
  const x = readFileSync(file, "utf8");
  let argv = [...x.split("<key>ProgramArguments</key><array>")[1].split("</array>")[0].matchAll(/<string>([^<]*)<\\/string>/g)].map((m) => un(m[1]));
  // caffeinate is macOS only; the stand-in runs what follows it.
  if (argv[0] === "/usr/bin/caffeinate") argv = argv.slice(2);
  const out = un(/<key>StandardOutPath<\\/key><string>([^<]*)</.exec(x)[1]);
  const fd = openSync(out, "a");
  const p = Bun.spawn(argv, { cwd: dirname(argv[1]), stdio: ["ignore", fd, fd], detached: true });
  p.unref();
  writeFileSync(pidf, String(p.pid));
} else if (cmd === "kickstart") process.exit(3);
else if (cmd === "print") { if (alive()) console.log("\\tpid = " + readFileSync(pidf, "utf8")); else { console.error("Could not find service"); process.exit(113); } }
else if (cmd === "bootout") { if (!alive()) { console.error("No such process"); process.exit(3); } process.kill(Number(readFileSync(pidf, "utf8"))); await Bun.sleep(300); rmSync(pidf); }
`.replace("HOME_DIR", home));
    await chmod(launchctl(), 0o755);
    const tokens = join(fleet.dir, "tokens");
    await writeFile(tokens, `${tokenLine("op", op, "operator")}\n`);
    const host = new FleetAdminHost({ confPath: fleet.confPath, fleetBin });
    const watchdog = new WatchdogService({ manager: "launchd", home, uid: 501, bash, path: process.env.PATH ?? "/usr/bin:/bin", launchctl: launchctl(), settleMs: 1500 });
    const store = new Store(":memory:");
    const deps = { fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store, watchdog: { host, watchdog } };
    server = serve(deps, 0, { auth: await Auth.fromFile(tokens) });
    gateway = startGateway({ hosts: [{ id: "h", name: "H", origin: server.url.origin }], credentials: new Credentials(new Map([["h", op]])) }, { port: 0 });
  });
  afterAll(async () => {
    gateway?.stop(true);
    server?.stop(true);
    const pid = Number(await readFile(join(home, "job.pid"), "utf8").catch(() => "0"));
    if (pid && pidAlive(pid)) process.kill(pid);
    await fleet?.cleanup();
    if (home?.includes("fleet-control-wd-home-")) await rm(home, { recursive: true, force: true });
  });

  const page = (path: string, init: RequestInit = {}) => fetch(`${gateway.url.origin}/api/hosts/h${path}`, { ...init, headers: { origin: gateway.url.origin, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });

  test("the page turns the real watchdog on and off through the gateway, and the agents' tmux server stays up", async () => {
    const before = await (await page("/watchdog")).json();
    const name = before.name as string;
    expect(before).toMatchObject({ manager: "launchd", installed: false, running: false, pid: null, inTmux: false });
    expect(name).toMatch(/^pl\.raqz\.fleet-watchdog\.fctest/);
    expect((await page("/watchdog", { method: "PUT", body: JSON.stringify({ on: true }) })).status).toBe(400);

    const on = await page("/watchdog", { method: "PUT", body: JSON.stringify({ on: true, confirm: "watchdog" }) });
    const onBody = await on.json();
    expect([on.status, onBody.running, onBody.installed]).toEqual([200, true, true]);
    expect(pidAlive(onBody.pid)).toBe(true);
    const file = join(home, "Library", "LaunchAgents", `${name}.plist`);
    expect(await Bun.file(file).exists()).toBe(true);
    // The real watchdog loaded the fleet and logged its start in FLEET_DIR.
    let log = "";
    for (let i = 0; i < 40 && !/watchdog start \(once=0 dry=0 quiet=1 agents=1\)/.test(log); i++) { await Bun.sleep(100); log = await readFile(join(fleet.dir, "watchdog.log"), "utf8").catch(() => ""); }
    expect(log).toMatch(/watchdog start \(once=0 dry=0 quiet=1 agents=1\)/);
    // Asking again changes nothing.
    await page("/watchdog", { method: "PUT", body: JSON.stringify({ on: true, confirm: "watchdog" }) });
    expect((await readFile(join(home, "calls"), "utf8")).split("\n").filter((l) => l.startsWith("bootstrap")).length).toBe(1);

    const off = await (await page("/watchdog", { method: "PUT", body: JSON.stringify({ on: false, confirm: "watchdog" }) })).json();
    expect([off.running, off.installed]).toEqual([false, false]);
    expect(pidAlive(onBody.pid)).toBe(false);
    expect(await Bun.file(file).exists()).toBe(false);
    expect((await fleet.tmux("has-session", "-t", `=${fleet.session}`)).exitCode).toBe(0);
  });

  test("a watchdog started by hand in tmux blocks a second one", async () => {
    const name = (await (await page("/watchdog")).json()).fleet as string;
    await fleet.tmux("new-session", "-d", "-s", `${name}-watchdog`, "exec sleep 60");
    try {
      const r = await page("/watchdog", { method: "PUT", body: JSON.stringify({ on: true, confirm: "watchdog" }) });
      expect([r.status, (await r.json()).error.message]).toEqual([409, `a watchdog already runs in tmux session ${name}-watchdog; stop it with fleet watchdog stop first`]);
      expect((await (await page("/watchdog")).json()).inTmux).toBe(true);
    } finally {
      await fleet.tmux("kill-session", "-t", `=${name}-watchdog`);
    }
  });

  test("a watchdog that exits at once is reported as failed and its service removed", async () => {
    const watchdog = new WatchdogService({ manager: "launchd", home, uid: 501, bash: bash!, path: "/nonexistent", launchctl: launchctl(), settleMs: 1500 });
    const broken = join(fleet.dir, "watchdog.sh");
    const keep = await readFile(broken, "utf8");
    await writeFile(broken, "echo broken on purpose >&2\nexit 2\n");
    try {
      const f = { fleet: "brokenfleet", dir: fleet.dir, socket: fleet.socket };
      await expect(watchdog.start(f)).rejects.toThrow("the watchdog did not keep running: broken on purpose");
      expect(await Bun.file(join(home, "Library", "LaunchAgents", "pl.raqz.fleet-watchdog.brokenfleet.plist")).exists()).toBe(false);
    } finally {
      await writeFile(broken, keep);
    }
  });
});
