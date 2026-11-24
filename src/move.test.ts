// Move fleet: the request rules, the fleet.conf rewrite, what blocks a move, and the use cases.
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newToken, tokenLine } from "./auth.ts";
import { AdminError } from "./domain/fleet-admin.ts";
import { checkMoveRequest, moveBlockers, movedConf, type MoveFacts } from "./domain/move.ts";
import { moveUseCases, type MoveDeps } from "./application/move.ts";
import { FleetAdminHost } from "./fleet/admin.ts";

const fail = (f: () => unknown) => { try { f(); } catch (e) { return e as AdminError; } throw new Error("did not throw"); };
const failAsync = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AdminError; } throw new Error("did not throw"); };
const to = { fleet: "prod", dir: "/srv/fleets/prod", socket: "fleet-prod" };

test("a move request needs a plain name, a plain folder two levels deep, a plain socket and the typed word", () => {
  expect(checkMoveRequest({ fleet: " prod ", dir: "/srv/fleets/prod/", socket: "fleet-prod", confirm: "move" })).toEqual(to);
  const refusals: [unknown, string][] = [
    [null, "body must be an object"],
    [{ ...to, confirm: "move", extra: 1 }, "unknown field extra"],
    [{ ...to, fleet: "a b", confirm: "move" }, "fleet must be a plain name: letters, digits, - and _, up to 32"],
    [{ ...to, dir: "/srv", confirm: "move" }, "folder must be a plain absolute path at least two levels deep, without . or .."],
    [{ ...to, dir: "/srv/../etc", confirm: "move" }, "folder must be a plain absolute path at least two levels deep, without . or .."],
    [{ ...to, dir: "srv/x", confirm: "move" }, "folder must be a plain absolute path at least two levels deep, without . or .."],
    [{ ...to, socket: "-L", confirm: "move" }, "socket must be a plain tmux socket name"],
    [{ ...to, confirm: "yes" }, "type move to confirm"],
  ];
  for (const [input, message] of refusals) expect(fail(() => checkMoveRequest(input)).message).toBe(message);
});

test("the moved fleet.conf changes only the name, folder and socket lines, and refuses a file it cannot read safely", () => {
  const conf = "# test\nFLEET=old\nFLEET_DIR=/a/old\nAGENTS=(\"x|X|x.txt\")\n[ -f \"$FLEET_DIR/fleet-control-agents.conf\" ] && . \"$FLEET_DIR/fleet-control-agents.conf\"\n";
  expect(movedConf(conf, to)).toBe("# test\nFLEET=prod\nFLEET_DIR=/srv/fleets/prod\nFLEET_TMUX_SOCKET=fleet-prod\nAGENTS=(\"x|X|x.txt\")\n[ -f \"$FLEET_DIR/fleet-control-agents.conf\" ] && . \"$FLEET_DIR/fleet-control-agents.conf\"\n");
  expect(movedConf("FLEET=old\nFLEET_DIR=/a/old\nexport FLEET_TMUX_SOCKET=s\n", to)).toBe("FLEET=prod\nFLEET_DIR=/srv/fleets/prod\nexport FLEET_TMUX_SOCKET=fleet-prod\n");
  expect(fail(() => movedConf("FLEET_DIR=/a\n", to)).message).toBe("fleet.conf sets FLEET on 0 lines; a move needs exactly one FLEET= line");
  expect(fail(() => movedConf("FLEET=a\nFLEET=b\nFLEET_DIR=/a\n", to)).message).toBe("fleet.conf sets FLEET on 2 lines; a move needs exactly one FLEET= line");
  expect(fail(() => movedConf("FLEET=a\nFLEET_DIR=/a\n[ x ] && FLEET_DIR=/b\n", to)).message).toBe("fleet.conf sets the fleet's name, folder or socket in another way too ([ x ] && FLEET_DIR=/b); move it by hand");
  // A comment that mentions one is fine.
  expect(movedConf("FLEET=a # was FLEET=b\nFLEET_DIR=/a\n", to)).toBe("FLEET=prod\nFLEET_DIR=/srv/fleets/prod\nFLEET_TMUX_SOCKET=fleet-prod\n");
});

const facts = (over: Partial<MoveFacts> = {}): MoveFacts => ({
  from: { fleet: "old", dir: "/a/old", socket: "fleet-old" }, remote: "", agents: [], leases: [],
  watchdog: { installed: false, running: false, inTmux: false }, oldSessions: [], newSessions: [], targetUsed: false, settingsFile: true, confInDir: true, ...over,
});

test("a move waits until nothing runs on the old setup and the new place is free", () => {
  expect(moveBlockers(facts(), to)).toEqual([]);
  expect(moveBlockers(facts({ remote: "u@h", settingsFile: false, agents: ["fc-a"], leases: ["s1"], watchdog: { installed: true, running: true, inTmux: null }, oldSessions: ["probe"], newSessions: ["x"], targetUsed: true }), to)).toEqual([
    "this fleet runs over REMOTE_SSH; move it on that host",
    "this host has no settings file (FLEET_CONTROL_TOKENS or FLEET_CONTROL_SETTINGS), which keeps the new fleet.conf path",
    "stop the managed agents first: fc-a",
    "end the typing in s1 first",
    "turn the watchdog service off first; it runs for the old folder",
    "cannot tell whether a watchdog runs by hand in tmux; fix tmux first",
    "/srv/fleets/prod exists and is not empty; choose a new folder",
    "end the fleet's tmux sessions first (probe); they run on the old setup",
    "tmux server fleet-prod already runs x; choose another socket",
  ]);
  expect(moveBlockers(facts({ watchdog: { installed: false, running: false, inTmux: true } }))).toEqual(["stop the watchdog that runs by hand in tmux first (fleet watchdog stop)"]);
  expect(moveBlockers(facts(), { fleet: "old", dir: "/a/old", socket: "fleet-old" })).toEqual(["nothing to move: the name, folder and socket are the ones in use"]);
  expect(moveBlockers(facts(), { fleet: "new", dir: "/a/old", socket: "fleet-old" })).toEqual(["a move needs a new folder; the name and socket change only together with it"]);
  expect(moveBlockers(facts(), { ...to, dir: "/a/old/inner" })).toEqual(["the new folder must not be inside the old one, nor the old inside the new"]);
  expect(moveBlockers(facts(), { ...to, dir: "/a" })).toEqual(["the new folder must not be inside the old one, nor the old inside the new"]);
  // Review round 1: running sessions block a move that keeps the socket too, and a fleet.conf outside FLEET_DIR blocks it.
  expect(moveBlockers(facts({ oldSessions: ["probe"] }), { ...to, socket: "fleet-old" })).toEqual(["end the fleet's tmux sessions first (probe); they run on the old setup"]);
  expect(moveBlockers(facts({ confInDir: false }), to)).toEqual(["the service's FLEET_CONF is not FLEET_DIR/fleet.conf; move a fleet whose fleet.conf lives elsewhere by hand"]);
});

test("review round 1: export stays on the rewritten lines, and declare or default-value forms are refused", () => {
  expect(movedConf("export FLEET=a\nexport FLEET_DIR=/a\nexport FLEET_TMUX_SOCKET=s\n", to)).toBe("export FLEET=prod\nexport FLEET_DIR=/srv/fleets/prod\nexport FLEET_TMUX_SOCKET=fleet-prod\n");
  expect(fail(() => movedConf("FLEET=a\nFLEET_DIR=/a\n: ${FLEET_DIR:=/b}\n", to)).message).toBe("fleet.conf sets the fleet's name, folder or socket in another way too (: ${FLEET_DIR:=/b}); move it by hand");
  expect(fail(() => movedConf("FLEET=a\nFLEET_DIR=/a\ndeclare FLEET_TMUX_SOCKET\n", to)).message).toBe("fleet.conf sets the fleet's name, folder or socket in another way too (declare FLEET_TMUX_SOCKET); move it by hand");
  // Reading the value is fine.
  expect(movedConf("FLEET=a\nFLEET_DIR=/a\nLOG=$FLEET_DIR/log\n", to)).toBe("FLEET=prod\nFLEET_DIR=/srv/fleets/prod\nFLEET_TMUX_SOCKET=fleet-prod\nLOG=$FLEET_DIR/log\n");
  // Review round 2: reads next to export or read are fine; appends, printf -v and unset are not.
  for (const ok of ["export LOG=$FLEET_DIR/log", 'export PATH="${FLEET_DIR}/bin:$PATH"', "X=${FLEET_TMUX_SOCKET:-none}", "Y=${FLEET_DIR:+set}", "Z=${FLEET:?unset}", "A=1 # FLEET_DIR=/z"])
    expect(movedConf(`FLEET=a\nFLEET_DIR=/a\n${ok}\n`, to)).toBe(`FLEET=prod\nFLEET_DIR=/srv/fleets/prod\nFLEET_TMUX_SOCKET=fleet-prod\n${ok}\n`);
  for (const bad of ["FLEET_DIR+=/x", "printf -v FLEET_DIR %s /x", "unset FLEET_TMUX_SOCKET", ": ${FLEET_DIR=/b}", "X=a#b; FLEET_DIR=/z"])
    expect(fail(() => movedConf(`FLEET=a\nFLEET_DIR=/a\n${bad}\n`, to)).message).toBe(`fleet.conf sets the fleet's name, folder or socket in another way too (${bad}); move it by hand`);
});

test("the use cases: operator only, blockers named, a moved fleet.conf that would not load refused, the updater gets the job", async () => {
  const conf = "FLEET=old\nFLEET_DIR=/a/old\nFLEET_TMUX_SOCKET=fleet-old\nAGENTS=()\n";
  const started: unknown[] = [];
  let agents: string[] = [];
  let loads = true;
  const deps: MoveDeps = {
    host: {
      path: "/a/old/fleet.conf",
      read: async () => conf,
      facts: async (text) => {
        if (!loads && text !== conf) throw new Error("set -e failed");
        // Stands in for bash: a single-quoted value reads without its quotes.
        const v = (k: string) => (text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").replace(/^'(.*)'$/, "$1");
        return { fleet: v("FLEET"), dir: v("FLEET_DIR"), socket: v("FLEET_TMUX_SOCKET"), remote: "", sessions: [] };
      },
      panes: async () => [],
    },
    watchdog: { state: async () => ({ manager: "launchd", name: "w", installed: false, running: false, pid: null, inTmux: false }), start: async () => {}, stop: async () => {} },
    agents: () => agents, leases: () => [],
    targetUsed: async () => false, settingsFile: "/c/settings.json", unavailable: () => null,
    start: async (m, by) => { started.push({ m, by }); return { id: "upd-20261123T120000Z-0000abcd", action: "move", tag: null, commit: null, by, state: "starting", steps: [], startedAt: "x", endedAt: null }; },
  };
  const op = { name: "op", role: "operator" as const }, agent = { name: "a", role: "agent" as const };
  expect((await failAsync(moveUseCases(deps, agent).move({ ...to, confirm: "move" }))).message).toBe("role agent may not start or stop agents");
  expect(await moveUseCases(deps, op).get()).toEqual({ from: { fleet: "old", dir: "/a/old", socket: "fleet-old" }, unavailable: null, blockers: [] });
  agents = ["fc-x"];
  const blocked = await failAsync(moveUseCases(deps, op).move({ ...to, confirm: "move" }));
  expect([blocked.kind, blocked.message]).toEqual(["failed", "not moved: stop the managed agents first: fc-x"]);
  agents = [];
  loads = false;
  expect((await failAsync(moveUseCases(deps, op).move({ ...to, confirm: "move" }))).message).toBe("the moved fleet.conf would not load (set -e failed); nothing moved");
  loads = true;
  expect(started).toEqual([]);
  const r = await moveUseCases(deps, op).move({ ...to, confirm: "move" });
  expect(r.job.action).toBe("move");
  expect(started).toEqual([{ m: { from: { fleet: "old", dir: "/a/old", socket: "fleet-old" }, to, settingsFile: "/c/settings.json", confSha256: new Bun.CryptoHasher("sha256").update(conf).digest("hex") }, by: "op" }]);
  // Without the updater nothing starts.
  const off = await failAsync(moveUseCases({ ...deps, unavailable: () => "not started by launchd or systemd" }, op).move({ ...to, confirm: "move" }));
  expect([off.kind, off.message]).toEqual(["failed", "not started by launchd or systemd"]);
  // tmux's default server: every session on it would come along.
  const dflt = await failAsync(moveUseCases({ ...deps, host: { ...deps.host, read: async () => "FLEET=old\nFLEET_DIR=/a/old\nFLEET_TMUX_SOCKET=\n" } }, op).move({ ...to, confirm: "move" }));
  expect(dflt.message).toBe("this fleet uses tmux's default server; a move would take every session on it along, so move it by hand");
});

const procs: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];
afterAll(async () => { for (const p of procs) { p.kill(); await p.exited; } for (const d of dirs) await rm(d, { recursive: true, force: true }); });
const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => done(port)); }); });

test("the real service takes FLEET_CONF from the settings file, says which fleet.conf it runs, and the settings page cannot change it", async () => {
  const d = await mkdtemp(join(tmpdir(), "fc-move-svc-")); dirs.push(d);
  const op = newToken(), agent = newToken();
  await writeFile(join(d, "tokens"), `${tokenLine("op", op, "operator")}\n${tokenLine("worker", agent, "agent")}\n`, { mode: 0o600 });
  const oldDir = join(d, "old"), newDir = join(d, "new");
  await mkdir(oldDir); await mkdir(newDir);
  await writeFile(join(oldDir, "fleet.conf"), `FLEET=move-old-${process.pid}\nFLEET_DIR=${oldDir}\nFLEET_TMUX_SOCKET=fc-move-old-${process.pid}\nAGENTS=()\n`);
  await writeFile(join(newDir, "fleet.conf"), `FLEET=move-new-${process.pid}\nFLEET_DIR=${newDir}\nFLEET_TMUX_SOCKET=fc-move-new-${process.pid}\nAGENTS=()\n`);
  await writeFile(join(d, "settings.json"), JSON.stringify({ fleetConf: join(newDir, "fleet.conf") }), { mode: 0o600 });
  const port = await freePort();
  const proc = Bun.spawn(["bun", "index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PORT: String(port), FLEET_CONF: join(oldDir, "fleet.conf"), FLEET_CONTROL_DB: join(d, "state.db"), FLEET_CONTROL_TOKENS: join(d, "tokens"), FLEET_CONTROL_ADMIN: "1", FLEET_CONTROL_AGENT_ROOTS: "", FLEET_CONTROL_INPUT: "", FLEET_CONTROL_SETTINGS: "", XPC_SERVICE_NAME: "", INVOCATION_ID: "" },
    stdout: "pipe", stderr: "pipe",
  });
  procs.push(proc);
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit = {}, token = op) => fetch(`${base}/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base, ...(init.headers ?? {}) } });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await call("/whoami")).ok; } catch { await Bun.sleep(100); } }
  if (!up) throw new Error(`service did not start: ${await new Response(proc.stderr as ReadableStream).text()}`);
  // The fleet section reads the fleet.conf named in the settings file, not the one in the environment.
  const conf = await (await call("/fleet/conf")).json();
  expect(conf.path).toBe(join(newDir, "fleet.conf"));
  const running = JSON.parse(await readFile(join(d, "settings.json.running"), "utf8"));
  expect([running.pid, running.fleetConf]).toEqual([proc.pid, join(newDir, "fleet.conf")]);
  // The settings page keeps that value and refuses to change it.
  const read = await (await call("/settings")).json();
  expect(read.running.fleetConf).toBe(join(newDir, "fleet.conf"));
  const same = await call("/settings", { method: "PUT", body: JSON.stringify({ settings: { ...read.running, input: true }, revision: read.revision, confirm: "settings" }) });
  expect(same.status).toBe(200);
  expect(JSON.parse(await readFile(join(d, "settings.json"), "utf8")).fleetConf).toBe(join(newDir, "fleet.conf"));
  const again = await (await call("/settings")).json();
  const other = await call("/settings", { method: "PUT", body: JSON.stringify({ settings: { ...again.running, fleetConf: join(oldDir, "fleet.conf") }, revision: again.revision, confirm: "settings" }) });
  expect([other.status, (await other.json()).error.message]).toEqual([400, "fleetConf changes only through Move fleet"]);
  // The move route: an agent may not, a page from elsewhere may not, and a body must be JSON.
  expect((await call("/fleet/move", {}, agent)).status).toBe(403);
  expect((await call("/fleet/move", { method: "POST", body: "{}", headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await call("/fleet/move", { method: "POST", body: "x", headers: { "content-type": "text/plain" } })).status).toBe(415);
  // Outside launchd and systemd the move is named as unavailable, not attempted.
  const view = await (await call("/fleet/move")).json();
  expect([view.from.dir, typeof view.unavailable]).toEqual([newDir, "string"]);
  const tried = await call("/fleet/move", { method: "POST", body: JSON.stringify({ fleet: "x", dir: join(d, "elsewhere"), socket: "fc-x", confirm: "move" }) });
  expect(tried.status).toBe(422);
}, 60_000);

test("live finding: a fleet.conf with the managed agents line can be moved; its rewrite is loaded with the old folder, which exists", async () => {
  const d = await mkdtemp(join(tmpdir(), "fc-move-include-"));
  try {
    const old = join(d, "old");
    await mkdir(old);
    const conf = `FLEET=old\nFLEET_DIR=${old}\nAGENTS=("probe|Probe|probe.txt")\n# fleet-control managed agents\n[ -f "$FLEET_DIR/fleet-control-agents.conf" ] && . "$FLEET_DIR/fleet-control-agents.conf"\n`;
    await writeFile(join(old, "fleet.conf"), conf);
    await writeFile(join(old, "fleet-control-agents.conf"), "\n");
    const host = new FleetAdminHost({ confPath: join(old, "fleet.conf"), fleetBin: "" });
    const started: unknown[] = [];
    const deps: MoveDeps = {
      host: { path: host.path, read: () => host.read(), facts: (t) => host.facts(t), panes: async () => [] },
      watchdog: null, agents: () => [], leases: () => [], targetUsed: async () => false, settingsFile: "/c/settings.json", unavailable: () => null,
      start: async (m, by) => { started.push(m); return { id: "upd-20261124T000000Z-0000abcd", action: "move", tag: null, commit: null, by, state: "starting", steps: [], startedAt: "x", endedAt: null }; },
    };
    const to = { fleet: "new", dir: join(d, "new"), socket: "fleet-new" };
    await moveUseCases(deps, { name: "op", role: "operator" }).move({ ...to, confirm: "move" });
    expect(started.length).toBe(1);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test("review: the rewrite check quotes an old folder with a space or a quote in it", async () => {
  const d = await mkdtemp(join(tmpdir(), "fc-move-quote-"));
  try {
    const old = join(d, "my old's");
    await mkdir(old);
    const conf = `FLEET=old\nFLEET_DIR=\"${old}\"\nAGENTS=("probe|Probe|probe.txt")\n# fleet-control managed agents\n[ -f "$FLEET_DIR/fleet-control-agents.conf" ] && . "$FLEET_DIR/fleet-control-agents.conf"\n`;
    await writeFile(join(old, "fleet.conf"), conf);
    await writeFile(join(old, "fleet-control-agents.conf"), "\n");
    const host = new FleetAdminHost({ confPath: join(old, "fleet.conf"), fleetBin: "" });
    const started: unknown[] = [];
    const deps: MoveDeps = {
      host: { path: host.path, read: () => host.read(), facts: (t) => host.facts(t), panes: async () => [] },
      watchdog: null, agents: () => [], leases: () => [], targetUsed: async () => false, settingsFile: "/c/settings.json", unavailable: () => null,
      start: async (m, by) => { started.push(m); return { id: "upd-20261124T000000Z-0000abcd", action: "move", tag: null, commit: null, by, state: "starting", steps: [], startedAt: "x", endedAt: null }; },
    };
    const to = { fleet: "new", dir: join(d, "new"), socket: "fleet-new" };
    await moveUseCases(deps, { name: "op", role: "operator" }).move({ ...to, confirm: "move" });
    expect(started.length).toBe(1);
    expect(started[0]).toMatchObject({ from: { dir: old }, to: { dir: to.dir } });
  } finally { await rm(d, { recursive: true, force: true }); }
});
