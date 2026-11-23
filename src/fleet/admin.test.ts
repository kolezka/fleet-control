import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readdir, rm, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Auth, newToken, tokenLine } from "../auth.ts";
import { Store } from "../data/store.ts";
import { createTestFleet, type TestFleet } from "./fixture.ts";
import { FleetAdminHost, serviceLogFromEnv, unquoteTmux } from "./admin.ts";
import { SessionStarts } from "../data/session-starts.ts";
import { resolveFleetBin } from "./path.ts";
import { serve } from "../server.ts";
import { Credentials, startGateway } from "../client-gateway.ts";
import { MANAGED_INCLUDE } from "../domain/fleet-admin.ts";

// Real files, real bash, real tmux and the real agent-fleet CLI for logs. The restart uses a stand-in
// fleet CLI that records how it was called and opens the session, so no agent is started.
const fleetBin = resolveFleetBin();
const usable = (await Bun.file(fleetBin).exists()) && Bun.which("tmux") !== null;
if (!usable) console.warn("SKIP fleet admin test: needs the agent-fleet CLI and tmux");

describe.skipIf(!usable)("fleet administration on a private fleet", () => {
  let fleet: TestFleet, server: ReturnType<typeof serve>, gateway: ReturnType<typeof startGateway>, conf0: string;
  const op = newToken(), agent = newToken();
  const serviceLog = () => join(fleet.dir, "service.log");
  beforeAll(async () => {
    fleet = await createTestFleet(fleetBin);
    // The hand-written file as installed: the managed agents line at the end.
    conf0 = (await readFile(fleet.confPath, "utf8")) + `# fleet-control managed agents\n${MANAGED_INCLUDE}\n`;
    await writeFile(fleet.confPath, conf0);
    // Installed hosts have it: without it the include line is the file's failing last command.
    await writeFile(join(fleet.dir, "fleet-control-agents.conf"), "");
    await mkdir(join(fleet.dir, "moved"));
    await writeFile(join(fleet.dir, "moved", "fleet-control-agents.conf"), "");
    // Keeps the tmux server up while the probe session is restarted, so session ids keep counting.
    await fleet.tmux("new-session", "-d", "-s", "keeper", "exec sleep 600");
    await chmod(fleet.confPath, 0o640);
    await writeFile(join(fleet.dir, "watchdog.log"), Array.from({ length: 30 }, (_, i) => `wd line ${i + 1}`).join("\n") + "\n");
    await writeFile(serviceLog(), "svc one\nsvc two\nsvc three\n");
    // Records argv and FLEET_CONF, then opens the session the way a start would.
    await writeFile(join(fleet.dir, "fake-fleet"), `#!/bin/bash\nprintf '%s|%s\\n' "$*" "$FLEET_CONF" >> "${fleet.dir}/fake-calls"\n[ "$1" = start ] || exit 2\ntmux -L ${fleet.socket} -f /dev/null new-session -d -s "$2" "exec sleep 600" && echo "$2: started"\n`);
    await chmod(join(fleet.dir, "fake-fleet"), 0o755);
    const tokens = join(fleet.dir, "tokens");
    await writeFile(tokens, `${tokenLine("op", op, "operator")}\n${tokenLine("worker", agent, "agent")}\n`);
    const host = new FleetAdminHost({ confPath: fleet.confPath, fleetBin, serviceLog: { file: serviceLog() } });
    // Logs through the real CLI, restarts through the stand-in.
    const restarter = new FleetAdminHost({ confPath: fleet.confPath, fleetBin: join(fleet.dir, "fake-fleet") });
    // Saved starts go to the real host: real tmux new-session. fleet start goes to the stand-in.
    host.restart = (s, socket, start) => (start ? new FleetAdminHost({ confPath: fleet.confPath, fleetBin, settleMs: 300 }).restart(s, socket, start) : restarter.restart(s, socket));
    const store = new Store(":memory:");
    const deps = { fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store, admin: { host, starts: new SessionStarts(store.db) } };
    server = serve(deps, 0, { auth: await Auth.fromFile(tokens) });
    gateway = startGateway({ hosts: [{ id: "h", name: "H", origin: server.url.origin }], credentials: new Credentials(new Map([["h", op]])) }, { port: 0 });
  });
  afterAll(async () => {
    gateway?.stop(true);
    server?.stop(true);
    await fleet?.cleanup();
  });

  // As the page calls it: through the gateway, same origin, JSON bodies.
  const page = (path: string, init: RequestInit = {}) => fetch(`${gateway.url.origin}/api/hosts/h${path}`, { ...init, headers: { origin: gateway.url.origin, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const direct = (token: string, path: string, init: RequestInit = {}) => fetch(`${server.url.origin}/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

  test("an agent token can neither read nor change anything here", async () => {
    for (const [path, init] of [["/fleet/conf", {}], ["/fleet/conf", { method: "PUT", body: "{}" }], ["/fleet/logs?source=watchdog", {}], [`/sessions/${fleet.session}/restart`, { method: "POST", body: JSON.stringify({ confirm: fleet.session }) }]] as const) {
      const r = await direct(agent, path, init as RequestInit);
      expect([path, r.status, (await r.json()).error.message]).toEqual([path, 403, "role agent may not start or stop agents"]);
    }
    expect(await readFile(fleet.confPath, "utf8")).toBe(conf0);
  });

  test("the page reads fleet.conf, saves an edit with a backup, and a stale or broken save changes nothing", async () => {
    const read = await (await page("/fleet/conf")).json();
    expect(read.text).toBe(conf0);
    expect(read.loadError).toBeNull();
    expect(read.sessions).toEqual([fleet.session]);
    const edited = conf0.replace(`AGENTS=("${fleet.session}|Probe shell|probe.txt")`, `AGENTS=("${fleet.session}|Probe shell|probe.txt" "extra|Extra|extra.txt")`);
    expect(edited).not.toBe(conf0);

    // New lines go above the managed agents line, which stays last.
    const above = (line: string) => edited.replace(MANAGED_INCLUDE, `${line}\n${MANAGED_INCLUDE}`);
    const broken = await page("/fleet/conf", { method: "PUT", body: JSON.stringify({ text: above("if then"), revision: read.revision, confirm: "fleet.conf" }) });
    expect(broken.status).toBe(400);
    expect((await broken.json()).error.message).toStartWith("bash -n: ");
    const moved = await page("/fleet/conf", { method: "PUT", body: JSON.stringify({ text: edited.replace(`FLEET_DIR=${fleet.dir}`, `FLEET_DIR=${fleet.dir}/moved`), revision: read.revision, confirm: "fleet.conf" }) });
    expect((await moved.json()).error.message).toBe(`FLEET_DIR cannot change from the page (it is "${fleet.dir}"); change it on the host and restart the service`);
    // agent-fleet sources the file under set -euo pipefail: a failing command anywhere, an unset variable or
    // a return before the end breaks it (or drops the managed agents), so each is refused.
    const loads = "fleet.conf does not load: sourcing it the way agent-fleet does (set -euo pipefail) failed: a command in it fails, a variable is unset, or FLEET or FLEET_DIR is missing";
    for (const [line, message] of [
      ["false", loads],
      ["X=$UNSET_VARIABLE_FOR_TEST", loads],
      ["return 0", "fleet.conf does not load: it stops before its end (return or exit), so the lines after it, the managed agents among them, never load"],
      ["exit 0", "fleet.conf does not load: it stops before its end (return or exit), so the lines after it, the managed agents among them, never load"],
      // The real check's marker carries a fresh nonce, so a file cannot fake having run to its end.
      ["__FLEET_CONTROL_END=1; return 0", "fleet.conf does not load: it stops before its end (return or exit), so the lines after it, the managed agents among them, never load"],
      // fleet sets CONF and LOCAL_DIR before sourcing, the watchdog does not; a file needing them fails there.
      ['X="$CONF"', loads],
    ] as const) {
      const r = await page("/fleet/conf", { method: "PUT", body: JSON.stringify({ text: edited.replace("AGENTS=(", `${line}\nAGENTS=(`), revision: read.revision, confirm: "fleet.conf" }) });
      expect([line, r.status, (await r.json()).error?.message]).toEqual([line, 400, message]);
    }
    // A heredoc left open swallows the rest of the file. bash 5's -n warns about it and the warning is a refusal;
    // bash 3.2's -n is silent, and then the load check refuses it (agent-fleet itself needs bash 4 or newer).
    const heredoc = await page("/fleet/conf", { method: "PUT", body: JSON.stringify({ text: above("cat <<EOF"), revision: read.revision, confirm: "fleet.conf" }) });
    expect([heredoc.status, (await heredoc.json()).error.message]).toEqual([400, expect.stringMatching(/^bash -n: .*here-document|^fleet\.conf does not load: /)]);
    // A trailing backslash cannot pull the check's own marker line into the file's last command: one followed
    // by a newline loads (as in agent-fleet), one at the very end fails in agent-fleet's bash and is refused.
    const checker = new FleetAdminHost({ confPath: fleet.confPath, fleetBin });
    // ("true \\" + newline would otherwise take the marker as its argument; agent-fleet loads it fine.)
    expect((await checker.facts(edited + "true \\\n")).sessions).toEqual([fleet.session, "extra"]);
    expect(await checker.facts(edited + "X=1 \\").then(() => "", (e) => e.message)).toBe("it ends with a backslash and no newline; add a newline at the end");
    // The same lines through agent-fleet itself: each makes `fleet log` fail, so the refusal matches the CLI.
    // A failing test in the middle of an && list does not stop bash under set -e, in agent-fleet or here.
    const midList = "[ -f /nonexistent-fleet-test ] && . /nonexistent-fleet-test";
    for (const [line, code] of [["false", 1], ["X=$UNSET_VARIABLE_FOR_TEST", 1], [midList, 0]] as const) {
      const probe = join(fleet.dir, "probe.conf");
      await writeFile(probe, edited.replace("AGENTS=(", `${line}\nAGENTS=(`));
      const p = Bun.spawnSync([fleetBin, "log", "1"], { env: { ...process.env, FLEET_CONF: probe } });
      expect([line, p.exitCode]).toEqual([line, code]);
      await rm(probe);
    }
    expect(await readFile(fleet.confPath, "utf8")).toBe(conf0);

    const saved = await page("/fleet/conf", { method: "PUT", body: JSON.stringify({ text: edited, revision: read.revision, confirm: "fleet.conf" }) });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.sessions).toEqual([fleet.session, "extra"]);
    expect(await readFile(fleet.confPath, "utf8")).toBe(edited);
    expect(await readFile(body.backup, "utf8")).toBe(conf0);
    // The file and its backup keep the file's own mode; no temp file is left beside them.
    expect((await stat(fleet.confPath)).mode & 0o777).toBe(0o640);
    expect((await stat(body.backup)).mode & 0o777).toBe(0o640);
    expect((await readdir(fleet.dir)).filter((f) => f.startsWith("."))).toEqual([]);

    // A symlinked fleet.conf stays a symlink; the file it points to is replaced.
    const real = join(fleet.dir, "real-fleet.conf"), link = join(fleet.dir, "linked-fleet.conf");
    await writeFile(real, edited);
    await symlink(real, link);
    const linked = new FleetAdminHost({ confPath: link, fleetBin });
    await linked.replace(edited, edited + "# via link\n");
    expect([(await lstat(link)).isSymbolicLink(), await readFile(real, "utf8")]).toEqual([true, edited + "# via link\n"]);
    // A change on the host between the read and the rename is a conflict (409 on the page), and nothing is written.
    const raced = await linked.replace("not what is on disk", "x").then(() => null, (e) => e);
    expect([raced?.constructor?.name, raced?.kind, await readFile(real, "utf8")]).toEqual(["AdminError", "conflict", edited + "# via link\n"]);
    // Only the successful save left a backup; the refused one removed its own.
    expect((await readdir(fleet.dir)).filter((f) => f.startsWith("real-fleet.conf.bak-")).length).toBe(1);
    for (const f of (await readdir(fleet.dir)).filter((f) => f.startsWith("real-fleet.conf.bak-"))) await rm(join(fleet.dir, f));
    await rm(link); await rm(real);

    // A second save from the first read is refused: the file moved on.
    const stale = await page("/fleet/conf", { method: "PUT", body: JSON.stringify({ text: conf0, revision: read.revision, confirm: "fleet.conf" }) });
    expect(stale.status).toBe(409);
    expect(await readFile(fleet.confPath, "utf8")).toBe(edited);
  });

  test("the page reads the last lines of the watchdog log and the service log", async () => {
    const wd = await (await page("/fleet/logs?source=watchdog&lines=3")).json();
    expect(wd).toEqual({ source: "watchdog", lines: 3, text: "wd line 28\nwd line 29\nwd line 30\n" });
    const svc = await (await page("/fleet/logs?source=service&lines=2")).json();
    expect(svc).toEqual({ source: "service", lines: 2, text: "svc two\nsvc three\n" });
    expect((await page("/fleet/logs?source=etc")).status).toBe(400);
  });

  test("a restart ends the session on the fleet's own tmux server and starts it again from fleet.conf", async () => {
    const before = (await fleet.tmux("list-sessions", "-F", "#{session_name} #{session_id}")).stdout;
    expect(before).toContain(`${fleet.session} `);
    const refused = await page(`/sessions/${fleet.session}/restart`, { method: "POST", body: JSON.stringify({ confirm: "nope" }) });
    expect(refused.status).toBe(400);
    expect(await Bun.file(join(fleet.dir, "fake-calls")).exists()).toBe(false);

    const r = await page(`/sessions/${fleet.session}/restart`, { method: "POST", body: JSON.stringify({ confirm: fleet.session }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ session: fleet.session, output: `${fleet.session}: started\n` });
    expect(await readFile(join(fleet.dir, "fake-calls"), "utf8")).toBe(`start ${fleet.session}|${fleet.confPath}\n`);
    // A new session, not the old one: its id changed.
    const id = (out: string) => out.split("\n").find((l) => l.startsWith(`${fleet.session} `))?.split(" ")[1];
    const after = (await fleet.tmux("list-sessions", "-F", "#{session_name} #{session_id}")).stdout;
    expect(id(after)).toBeDefined();
    expect(id(after)).not.toBe(id(before));
  });

  test("a hand-made session comes back with its saved command and folder, read first from tmux", async () => {
    // Started by hand on the fleet's tmux server: not in fleet.conf, so fleet start does not know it.
    const work = join(fleet.dir, "work dir");
    await mkdir(work);
    await fleet.tmux("new-session", "-d", "-s", "hand", "-c", work, `exec sleep 600 # it's "quoted" $HOME`);
    const listed = await (await page("/fleet/sessions")).json();
    const hand = listed.sessions.find((r: { session: string }) => r.session === "hand");
    expect(hand).toEqual({ session: "hand", inConf: false, running: true, saved: null, pane: { command: `exec sleep 600 # it's "quoted" $HOME`, cwd: work } });
    expect(listed.sessions.some((r: { session: string }) => r.session.startsWith("fc-"))).toBe(false);
    // No saved command yet: refused, the session keeps running.
    const id = async () => (await fleet.tmux("list-sessions", "-F", "#{session_name} #{session_id}")).stdout.split("\n").find((l) => l.startsWith("hand "))?.split(" ")[1];
    const first = await id();
    const unsaved = await page("/sessions/hand/restart", { method: "POST", body: JSON.stringify({ confirm: "hand" }) });
    expect(unsaved.status).toBe(400);
    expect(await id()).toBe(first);
    // Saved as the page pre-fills it from tmux, then restarted: a new session with the same command and folder.
    const save = await page("/sessions/hand/start", { method: "PUT", body: JSON.stringify({ command: hand.pane.command, cwd: hand.pane.cwd, confirm: "hand" }) });
    expect(save.status).toBe(200);
    const r = await page("/sessions/hand/restart", { method: "POST", body: JSON.stringify({ confirm: "hand" }) });
    expect([r.status, (await r.json()).output]).toEqual([200, "hand: started with its saved command\n"]);
    const second = await id();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    const pane = (await fleet.tmux("list-panes", "-t", "=hand", "-F", "#{pane_start_path}|#{pane_current_command}")).stdout.trim();
    expect(pane).toBe(`${work}|sleep`);
    // The stand-in fleet CLI was not asked to start it.
    expect((await readFile(join(fleet.dir, "fake-calls"), "utf8").catch(() => "")).includes("start hand")).toBe(false);
    // A command that ends at once is a failed start, said as such.
    await page("/sessions/hand/start", { method: "PUT", body: JSON.stringify({ command: "true", cwd: work, confirm: "hand" }) });
    const dies = await page("/sessions/hand/restart", { method: "POST", body: JSON.stringify({ confirm: "hand" }) });
    expect([dies.status, (await dies.json()).error.message]).toEqual([422, "the old hand session ended, and it did not start again: the session ended right after it started; check its command and folder"]);
    // Removing the saved command needs the name typed; then hand (not running, not in fleet.conf) is gone from the list.
    expect((await page("/sessions/hand/start?confirm=han", { method: "DELETE" })).status).toBe(400);
    expect((await page("/sessions/hand/start?confirm=hand", { method: "DELETE" })).status).toBe(200);
    expect((await (await page("/fleet/sessions")).json()).sessions.some((x: { session: string }) => x.session === "hand")).toBe(false);
    // An agent token sees none of it.
    expect((await direct(agent, "/fleet/sessions")).status).toBe(403);
    expect((await direct(agent, "/sessions/hand/start", { method: "PUT", body: "{}" })).status).toBe(403);
  });

  test("tmux's quoted start command reads back as typed", () => {
    expect(unquoteTmux('"exec cat"')).toBe("exec cat");
    expect(unquoteTmux('"echo \\"hi \\$HOME\\" ; sleep 30"')).toBe('echo "hi $HOME" ; sleep 30');
    expect(unquoteTmux("")).toBe("");
  });

  test("the host tells a failed kill, a failed start and a start cut off by time apart", async () => {
    const tmuxStub = join(fleet.dir, "tmux-refuses");
    await writeFile(tmuxStub, `#!/bin/bash\necho "permission denied on socket" >&2\nexit 1\n`);
    await chmod(tmuxStub, 0o755);
    const killFails = await new FleetAdminHost({ confPath: fleet.confPath, fleetBin: join(fleet.dir, "fake-fleet"), tmuxBin: tmuxStub }).restart("nothing-here", "");
    expect(killFails).toEqual({ ok: false, stage: "kill", output: "tmux kill-session failed: permission denied on socket" });
    const slow = join(fleet.dir, "slow-fleet");
    await writeFile(slow, `#!/bin/bash\necho starting\nexec sleep 30\n`);
    await chmod(slow, 0o755);
    const cut = await new FleetAdminHost({ confPath: fleet.confPath, fleetBin: slow, restartTimeoutMs: 500 }).restart("nothing-here", fleet.socket);
    expect([cut.ok, cut.ok ? null : cut.stage]).toEqual([false, "timeout"]);
  });

  test("a start that fails after the restart is a definite answer on the page, not an unknown one", async () => {
    // The stand-in refuses to start this session, as fleet start does on a trust dialog.
    const failing = join(fleet.dir, "failing-fleet");
    await writeFile(failing, `#!/bin/bash\necho "$2: start FAILED: workspace trust dialog" >&2\nexit 1\n`);
    await chmod(failing, 0o755);
    const host = new FleetAdminHost({ confPath: fleet.confPath, fleetBin: failing });
    const s = serve({ fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" } as never, store: new Store(":memory:"), admin: { host } }, 0, { auth: await Auth.fromFile(join(fleet.dir, "tokens")) });
    const g = startGateway({ hosts: [{ id: "h", name: "H", origin: s.url.origin }], credentials: new Credentials(new Map([["h", op]])) }, { port: 0 });
    try {
      const r = await fetch(`${g.url.origin}/api/hosts/h/sessions/${fleet.session}/restart`, { method: "POST", headers: { origin: g.url.origin, "content-type": "application/json" }, body: JSON.stringify({ confirm: fleet.session }) });
      const body = await r.json();
      expect([r.status, body.error.message, body.error.outcome]).toEqual([422, `the old ${fleet.session} session ended, and it did not start again: ${fleet.session}: start FAILED: workspace trust dialog`, undefined]);
    } finally {
      g.stop(true);
      s.stop(true);
    }
  });
});

test("the service log setting is a file path or journal:<unit>", () => {
  expect(serviceLogFromEnv(undefined)).toBeUndefined();
  expect(serviceLogFromEnv("/Users/me/Library/Logs/fleet-control.log")).toEqual({ file: "/Users/me/Library/Logs/fleet-control.log" });
  expect(serviceLogFromEnv("journal:fleet-control")).toEqual({ unit: "fleet-control" });
  expect(() => serviceLogFromEnv("journal:a b")).toThrow("FLEET_CONTROL_SERVICE_LOG: journal:<unit> needs a plain unit name");
  expect(() => serviceLogFromEnv("logs/x.log")).toThrow("FLEET_CONTROL_SERVICE_LOG must be an absolute file path or journal:<unit>");
});
