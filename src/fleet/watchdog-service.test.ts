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
  test("only a missing session, server or socket reads as no tmux watchdog; other tmux errors read as unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-control-wd-tmux-"));
    const cases: [string, boolean | null][] = [
      ["can't find session: t-watchdog", false],
      ["no server running on /tmp/tmux-1000/fleet-t", false],
      ["error connecting to /private/tmp/tmux-501/fleet-t (No such file or directory)", false],
      ["error connecting to /tmp/tmux-1000/fleet-t (Connection refused)", false],
      ["error connecting to /private/tmp/tmux-501/fleet-t (Permission denied)", null],
      ["error connecting to /private/tmp/tmux-501/fleet-t (Socket operation on non-socket)", null],
      ["", null],
      ["first line\nsecond line", null],
    ];
    try {
      for (const [text, want] of cases) {
        const fake = join(dir, "tmux");
        await writeFile(fake, `#!/bin/sh\nprintf '%b\\n' ${JSON.stringify(text)} >&2\nexit 1\n`);
        await chmod(fake, 0o755);
        const w = new WatchdogService({ manager: "systemd", home: dir, uid: 1, bash: "/bin/bash", path: "/usr/bin:/bin", tmuxBin: fake, systemctl: "/usr/bin/true" });
        const st = await w.state({ fleet: "t", dir, socket: "fleet-t" });
        expect([text, st.inTmux]).toEqual([text, want]);
        if (want === null) expect(st.inTmuxError).toBe(text ? text.split("\n")[0] : "tmux exited 1");
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
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
    // systemd expands $VAR in ExecStart: a literal $ in a folder name must be written $$.
    expect(systemdUnit({ fleet: "t", dir: "/x/$HOME 100%", socket: "" }, "/b/bash", "/p")).toContain('ExecStart="/b/bash" "/x/$$HOME 100%%/watchdog.sh" --quiet-start');
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
    let running = false, inTmux: boolean | null = false, remote = "";
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
    // tmux could not be asked: on is refused, off still works.
    inTmux = null;
    await expect(op.set({ on: true, confirm: "watchdog" })).rejects.toThrow("cannot tell whether a watchdog runs in tmux");
    expect((await op.get()).inTmux).toBe(null);
    running = true;
    expect((await op.set({ on: false, confirm: "watchdog" })).running).toBe(false);
    calls.pop();
    inTmux = false; remote = "ssh x";
    await expect(op.get()).rejects.toThrow("this fleet runs over REMOTE_SSH; run its watchdog on that host");
    // A refusal the operator can act on is 422 on the wire; 503 would reach the page as "unknown".
    expect(await op.get().catch((e) => e.kind)).toBe("failed");
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

// Stand-ins that model what matters for a stop: launchd kills the job's whole process group unless the plist
// sets AbandonProcessGroup; systemd kills the unit's processes unless KillMode=process. A loaded launchd job
// keeps its old definition until bootout, and a bootstrap of a loaded label fails with 5.
const MANAGERS = `
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
const home = process.env.STANDIN_HOME;
const tool = process.argv[1].split("/").pop();
const a = process.argv.slice(2).filter((x) => x !== "--user");
appendFileSync(join(home, "calls"), tool + " " + a.join(" ") + "\\n");
const st = join(home, "state.json");
const S = existsSync(st) ? JSON.parse(readFileSync(st, "utf8")) : {};
const save = () => writeFileSync(st, JSON.stringify(S));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const start = (argv, cwd, out, path) => { const fd = openSync(out, "a"); const p = Bun.spawn(argv, { cwd, stdio: ["ignore", fd, fd], detached: true, env: { HOME: process.env.HOME, PATH: path } }); p.unref(); return p.pid; };
const kill = (pid, group) => { try { process.kill(group ? -pid : pid, "SIGTERM"); } catch {} };
const un = (x) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
if (tool === "launchctl") {
  const [cmd, target, file] = a;
  const label = cmd === "bootstrap" ? /<key>Label<\\/key><string>([^<]*)</.exec(readFileSync(file, "utf8"))[1] : target.split("/").pop();
  const job = S[label];
  if (cmd === "bootstrap") {
    if (S.__bootFail > 0) { S.__bootFail--; save(); console.error("Bootstrap failed: 5: Input/output error"); process.exit(5); }
    if (job) { console.error("Bootstrap failed: 5: Input/output error"); process.exit(5); }
    const x = readFileSync(file, "utf8");
    let argv = [...x.split("<key>ProgramArguments</key><array>")[1].split("</array>")[0].matchAll(/<string>([^<]*)<\\/string>/g)].map((m) => un(m[1]));
    if (argv[0] === "/usr/bin/caffeinate") argv = argv.slice(2);
    const out = un(/<key>StandardOutPath<\\/key><string>([^<]*)</.exec(x)[1]);
    const path = un(/<key>PATH<\\/key><string>([^<]*)</.exec(x)[1]);
    S[label] = { argv, abandon: x.includes("<key>AbandonProcessGroup</key><true/>"), pid: start(argv, dirname(argv[1]), out, path), out, path };
    save();
  } else if (cmd === "print") {
    if (job && job.linger !== undefined) {
      if (job.linger <= 0) { delete S[label]; save(); console.error("Could not find service"); process.exit(113); }
      job.linger--; save(); console.log("gui/501/" + label + " = {\\n\\tstate = not running\\n}"); process.exit(0);
    }
    if (!job) { console.error("Could not find service"); process.exit(113); }
    console.log("gui/501/" + label + " = {\\n\\tstate = " + (alive(job.pid) ? "running" : "not running") + (alive(job.pid) ? "\\n\\tpid = " + job.pid : "") + "\\n\\tendpoints = {\\n\\t\\tpid = 1\\n\\t}\\n}");
  } else if (cmd === "bootout") {
    if (!job) { console.error("Boot-out failed: 3: No such process"); process.exit(3); }
    kill(job.pid, !job.abandon);
    // Real launchd unloads a job it is killing later: "linger" keeps it loaded for n prints and refuses m bootstraps.
    const lf = join(home, "linger");
    if (existsSync(lf)) { const [n, m] = readFileSync(lf, "utf8").trim().split(" ").map(Number); rmSync(lf); job.linger = n; S.__bootFail = m; }
    else delete S[label];
    save(); await Bun.sleep(200);
  } else if (cmd === "kickstart") {
    if (!job) process.exit(113);
    if (!alive(job.pid)) { job.pid = start(job.argv, dirname(job.argv[1]), job.out, job.path); save(); }
  }
} else {
  const [cmd, ...rest] = a;
  const name = rest.at(-1);
  const unitFile = join(home, ".config/systemd/user", name ?? "");
  if (cmd === "daemon-reload") {}
  else if (cmd === "enable") {
    const x = readFileSync(unitFile, "utf8");
    const words = [...(/^ExecStart=(.*)$/m.exec(x)[1]).matchAll(/"((?:[^"\\\\]|\\\\.)*)"|(\\S+)/g)].map((m) => (m[1] ?? m[2]).replace(/\\$\\$/g, "$").replace(/%%/g, "%").replace(/\\\\(.)/g, "$1"));
    const out = /^StandardOutput=append:(.*)$/m.exec(x)[1].replace(/%%/g, "%");
    const path = /^Environment="PATH=(.*)"$/m.exec(x)[1].replace(/%%/g, "%");
    S[name] = { pid: start(words, dirname(words[1]), out, path), killProcessOnly: /^KillMode=process$/m.test(x), argv: words };
    save();
  } else if (cmd === "show") { console.log(S[name] && alive(S[name].pid) ? S[name].pid : 0); }
  else if (cmd === "disable") { if (S[name]) { kill(S[name].pid, !S[name].killProcessOnly); delete S[name]; save(); await Bun.sleep(200); } }
}
`;

describe.skipIf(bash === null)("stop keeps agents, on launchd and systemd (stand-in managers)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fleet-control-wd-model-"));
    for (const tool of ["launchctl", "systemctl"]) { await writeFile(join(dir, tool), `#!${process.execPath}\n${MANAGERS}`); await chmod(join(dir, tool), 0o755); }
    process.env.STANDIN_HOME = dir;
  });
  afterAll(async () => {
    const st = JSON.parse(await readFile(join(dir, "state.json"), "utf8").catch(() => "{}")) as Record<string, { pid: number }>;
    for (const j of Object.values(st)) { try { process.kill(-j.pid); } catch {} }
    delete process.env.STANDIN_HOME;
    if (dir.includes("fleet-control-wd-model-")) await rm(dir, { recursive: true, force: true });
  });

  // A watchdog that starts an "agent" in its own process group and then loops, as a real one does.
  const fakeFleet = async (name: string) => {
    const fdir = join(dir, `fleet $HOME ${name}`);
    await Bun.write(join(fdir, "watchdog.sh"), `echo "watchdog up PATH=$PATH"\n/bin/sleep 300 &\necho $! > agent.pid\nwhile true; do /bin/sleep 1; done\n`);
    return { fleet: name, dir: fdir, socket: "" };
  };
  const agentAlive = async (f: { dir: string }) => { const pid = Number(await readFile(join(f.dir, "agent.pid"), "utf8")); try { process.kill(pid, 0); return pid; } catch { return 0; } };
  const service = (manager: "launchd" | "systemd", path = "/usr/bin:/bin") => new WatchdogService({ manager, home: dir, uid: 501, bash: bash!, path, launchctl: join(dir, "launchctl"), systemctl: join(dir, "systemctl"), tmuxBin: "/usr/bin/false", settleMs: 600 });

  for (const manager of ["launchd", "systemd"] as const) {
    test(`${manager}: on starts watchdog.sh from a folder with spaces and $, off stops only the watchdog, and the agent it started keeps running`, async () => {
      const f = await fakeFleet(manager);
      const w = service(manager);
      const ok = new WatchdogService({ ...w.opts, tmuxBin: undefined });
      const st = { ...f, socket: `fc-wd-none-${process.pid}` };
      await ok.start(st);
      const on = await ok.state(st);
      expect([on.running, on.installed, on.inTmux]).toEqual([true, true, false]);
      // tmux as /usr/bin/false: the state still reads, on is refused, and off is not blocked.
      const host = { read: async () => "", facts: async () => ({ fleet: st.fleet, dir: st.dir, socket: st.socket, remote: "", sessions: [] }) };
      const broken = watchdogUseCases({ host, watchdog: w }, { name: "op", role: "operator" });
      const seen = await broken.get();
      expect([seen.running, seen.inTmux, seen.inTmuxError]).toEqual([true, null, "tmux exited 1"]);
      for (let i = 0; i < 30 && !(await Bun.file(join(f.dir, "agent.pid")).exists()); i++) await Bun.sleep(100);
      const agent = await agentAlive(f);
      expect(agent).toBeGreaterThan(0);
      expect(await readFile(join(f.dir, "watchdog.service.log"), "utf8")).toContain("watchdog up PATH=/usr/bin:/bin");
      await expect(broken.set({ on: true, confirm: "watchdog" })).rejects.toThrow("cannot tell whether a watchdog runs in tmux (tmux exited 1)");
      expect((await broken.set({ on: false, confirm: "watchdog" })).running).toBe(false);
      expect((await ok.state(st)).running).toBe(false);
      expect(await agentAlive(f)).toBe(agent);
      process.kill(agent);
    }, 20_000);
  }

  test("launchd: a job still loaded with an old definition is unloaded first, so the new plist is the one that runs", async () => {
    const f = await fakeFleet("stale");
    const st = { ...f, socket: `fc-wd-none-${process.pid}` };
    const old = new WatchdogService({ ...service("launchd", "/old/path").opts, tmuxBin: undefined });
    await old.start(st);
    // The watchdog exits (END_AT, or killed): the job stays loaded with the old definition.
    const S = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    process.kill(-S["pl.raqz.fleet-watchdog.stale"].pid);
    await Bun.sleep(300);
    const w = new WatchdogService({ ...service("launchd", "/new/path").opts, tmuxBin: undefined });
    expect((await w.state(st)).running).toBe(false);
    await w.start(st);
    let log = "";
    for (let i = 0; i < 30 && !log.includes("/new/path"); i++) { await Bun.sleep(100); log = await readFile(join(f.dir, "watchdog.service.log"), "utf8"); }
    expect(log.trim().split("\n").at(-1)).toBe("watchdog up PATH=/new/path");
    const calls = (await readFile(join(dir, "calls"), "utf8")).split("\n").filter((l) => l.includes("stale") && !l.includes(" print "));
    expect(calls.slice(-2).map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual(["launchctl bootout", "launchctl bootstrap"]);
    await w.stop(st);
    try { process.kill(Number(await readFile(join(f.dir, "agent.pid"), "utf8"))); } catch {}
  }, 20_000);

  test("launchd: a job that stays loaded for a while after bootout is waited for, and refused bootstraps are retried", async () => {
    const f = await fakeFleet("linger");
    const st = { ...f, socket: `fc-wd-none-${process.pid}` };
    const w = new WatchdogService({ ...service("launchd").opts, tmuxBin: undefined });
    await w.start(st);
    const S = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    process.kill(-S["pl.raqz.fleet-watchdog.linger"].pid);
    await Bun.sleep(300);
    await writeFile(join(dir, "linger"), "3 2");
    const before = (await readFile(join(dir, "calls"), "utf8")).split("\n").length;
    await w.start(st);
    expect((await w.state(st)).running).toBe(true);
    const calls = (await readFile(join(dir, "calls"), "utf8")).split("\n").slice(before - 1).filter((l) => l.includes("linger")).map((l) => l.split(" ")[1]);
    // bootout, then prints while it stays loaded (3) and the one that finds it gone, then bootstrap: refused twice, then taken.
    const between = calls.slice(calls.indexOf("bootout") + 1, calls.indexOf("bootstrap"));
    expect(between.filter((c) => c === "print").length).toBeGreaterThanOrEqual(4);
    expect(calls.filter((c) => c === "bootstrap").length).toBe(3);
    // Bootstrap refused more often than the retries allow: 422 and no plist left.
    await w.stop(st);
    try { process.kill(Number(await readFile(join(f.dir, "agent.pid"), "utf8"))); } catch {}
    await w.start(st);
    process.kill(-JSON.parse(await readFile(join(dir, "state.json"), "utf8"))["pl.raqz.fleet-watchdog.linger"].pid);
    await Bun.sleep(300);
    await writeFile(join(dir, "linger"), "0 5");
    const e = await w.start(st).catch((x) => x);
    expect([e.kind, /Bootstrap failed: 5/.test(e.message)]).toEqual(["failed", true]);
    expect(await Bun.file(join(dir, "Library/LaunchAgents/pl.raqz.fleet-watchdog.linger.plist")).exists()).toBe(false);
    try { process.kill(Number(await readFile(join(f.dir, "agent.pid"), "utf8"))); } catch {}
  }, 30_000);

  test("a start the manager refuses leaves no file behind, and refusals the operator can fix are 422, not 503", async () => {
    const f = await fakeFleet("refused");
    const st = { ...f, socket: `fc-wd-none-${process.pid}` };
    await writeFile(join(dir, "systemctl-fail"), "");
    const broken = join(dir, "systemctl-broken");
    await writeFile(broken, `#!/bin/sh\n[ "$2" = enable ] && { echo "Failed to enable unit: Access denied" >&2; exit 1; }\nexit 0\n`);
    await chmod(broken, 0o755);
    const w = new WatchdogService({ ...service("systemd").opts, systemctl: broken, tmuxBin: undefined });
    await expect(w.start(st)).rejects.toThrow("systemctl could not start fleet-watchdog-refused.service: Failed to enable unit: Access denied");
    expect(await Bun.file(join(dir, ".config/systemd/user/fleet-watchdog-refused.service")).exists()).toBe(false);
    const nob = new WatchdogService({ ...w.opts, bash: null });
    await nob.start(st).catch((e) => { expect([e.kind, e.message]).toEqual(["failed", "no bash 4 or newer on this host; the watchdog needs it (on macOS: brew install bash)"]); });
    const nos = new WatchdogService({ ...w.opts });
    await nos.start({ ...st, dir: join(dir, "nowhere") }).catch((e) => { expect(e.kind).toBe("failed"); });
  });
});

test("the gateway waits for a slow watchdog start instead of answering 504 after its usual 10 s", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-control-wd-slow-"));
  const op = newToken();
  await writeFile(join(dir, "tokens"), `${tokenLine("op", op, "operator")}\n`);
  let running = false;
  const slow = {
    state: async () => ({ manager: "launchd" as const, name: "pl.raqz.fleet-watchdog.t", installed: running, running, pid: running ? 1 : null, inTmux: false }),
    start: async () => { await Bun.sleep(16_000); running = true; },
    stop: async () => { running = false; },
  };
  const host = { read: async () => "", facts: async () => ({ fleet: "t", dir, socket: "", remote: "", sessions: [] }) };
  const server = serve({ fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store: new Store(":memory:"), watchdog: { host: host as never, watchdog: slow } }, 0, { auth: await Auth.fromFile(join(dir, "tokens")) });
  const gateway = startGateway({ hosts: [{ id: "h", name: "H", origin: server.url.origin }], credentials: new Credentials(new Map([["h", op]])) }, { port: 0 });
  try {
    const r = await fetch(`${gateway.url.origin}/api/hosts/h/watchdog`, { method: "PUT", headers: { origin: gateway.url.origin, "content-type": "application/json" }, body: JSON.stringify({ on: true, confirm: "watchdog" }) });
    expect(r.status).toBe(200);
    expect((await r.json()).running).toBe(true);
  } finally { gateway.stop(true); server.stop(true); await rm(dir, { recursive: true, force: true }); }
}, 30_000);
