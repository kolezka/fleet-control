import { expect, test } from "bun:test";
import { adminUseCases, revisionOf, type ConfFacts, type FleetHost, type PaneStart } from "./fleet-admin.ts";
import { Store } from "../data/store.ts";
import { SessionStarts } from "../data/session-starts.ts";
import { AdminError, MANAGED_INCLUDE } from "../domain/fleet-admin.ts";

const BASE = `FLEET=t\nFLEET_DIR=/f\nAGENTS=("probe-shell|Probe|p.txt")\n${MANAGED_INCLUDE}\n`;

// A host whose file lives in memory. facts() reads FLEET, FLEET_DIR and the session names the way bash would for these simple files.
function fakeHost(initial = BASE) {
  const calls: string[] = [];
  const state = { text: initial, backups: [] as string[], restartOk: true, restartStage: "start" as "kill" | "start" | "timeout", logs: "", managed: [] as string[], panes: [] as PaneStart[] };
  const facts = (text: string): ConfFacts => {
    if (text.includes("exit 7")) throw new Error("sourcing it failed");
    const get = (k: string) => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "";
    return { fleet: get("FLEET"), dir: get("FLEET_DIR"), socket: `fleet-${get("FLEET")}`, remote: get("REMOTE_SSH"), sessions: [...text.matchAll(/"([A-Za-z0-9._-]+)\|/g)].map((m) => m[1]!).concat(state.managed && text.includes(MANAGED_INCLUDE) && !/AGENTS=\(\)\s*$/.test(text) ? state.managed : []) };
  };
  const host: FleetHost = {
    path: "/f/fleet.conf",
    read: async () => state.text,
    syntax: async (t) => (t.includes("((") ? "line 2: syntax error near unexpected token" : null),
    facts: async (t) => facts(t),
    replace: async (current, t) => { calls.push("replace"); expect(current).toBe(state.text); state.backups.push(state.text); state.text = t; return `/f/fleet.conf.bak-${state.backups.length}`; },
    log: async (source, lines) => { calls.push(`log ${source} ${lines}`); return state.logs; },
    panes: async () => state.panes,
    restart: async (s, socket, start) => { calls.push(`restart ${s} ${socket}${start ? ` [${start.cwd}] ${start.command}` : ""}`); return state.restartOk ? { ok: true, output: `${s}: started\n` } : { ok: false, stage: state.restartStage, output: state.restartStage === "kill" ? "tmux kill-session failed: permission denied" : `${s}: start FAILED: claude UI not detected after 90 s\n` }; },
  };
  return { host, state, calls };
}
const operator = { name: "op", role: "operator" as const };
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AdminError; } throw new Error("expected a refusal"); };

test("only an operator reads or changes fleet.conf, reads logs or restarts a session", async () => {
  const { host, calls } = fakeHost();
  for (const role of ["agent", "viewer"] as const) {
    const use = adminUseCases({ host }, { name: role, role });
    for (const p of [use.conf(), use.saveConf({}), use.log("watchdog", null), use.restart("probe-shell", { confirm: "probe-shell" })]) {
      expect((await fail(p)).message).toBe(`role ${role} may not start or stop agents`);
    }
  }
  expect(calls).toEqual([]);
});

test("a save names the revision it was read at, keeps a backup and is refused when the file moved on", async () => {
  const { host, state, calls } = fakeHost();
  const use = adminUseCases({ host }, operator);
  const read = await use.conf();
  expect(read).toMatchObject({ path: "/f/fleet.conf", text: BASE, revision: revisionOf(BASE), sessions: ["probe-shell"] });

  const next = BASE.replace('AGENTS=("probe-shell|Probe|p.txt")', 'AGENTS=("probe-shell|Probe|p.txt" "second|Second|s.txt")');
  const saved = await use.saveConf({ text: next, revision: read.revision, confirm: "fleet.conf" });
  expect(saved).toEqual({ path: "/f/fleet.conf", revision: revisionOf(next), backup: "/f/fleet.conf.bak-1", sessions: ["probe-shell", "second"] });
  expect(state.backups).toEqual([BASE]);

  // The same old revision again: someone (here, the save above) changed the file since it was read.
  const stale = await fail(use.saveConf({ text: BASE, revision: read.revision, confirm: "fleet.conf" }));
  expect([stale.kind, stale.message]).toEqual(["conflict", "fleet.conf changed on the host since you read it; reload it and edit again"]);
  expect(state.text).toBe(next);
  expect(calls).toEqual(["replace"]);
});

test("a save is refused, and nothing written, for a bad shape, bad bash, a dropped agents line or a changed FLEET_DIR", async () => {
  const { host, state, calls } = fakeHost();
  const use = adminUseCases({ host }, operator);
  const revision = revisionOf(BASE);
  // Lines go above the include line, which stays last.
  const add = (line: string) => BASE.replace(MANAGED_INCLUDE, `${line}\n${MANAGED_INCLUDE}`);
  const cases: [unknown, string][] = [
    [{ text: BASE + "x=1\n", revision }, "type fleet.conf to confirm the save"],
    [{ text: BASE + "x=1\n", revision, confirm: "fleet.conf", extra: 1 }, "unknown field extra"],
    [{ text: BASE, revision: "abc", confirm: "fleet.conf" }, "revision must be the SHA-256 the file was read with"],
    [{ text: "x".repeat(32 * 1024 + 1), revision, confirm: "fleet.conf" }, "fleet.conf may be at most 32768 bytes"],
    [{ text: add("(("), revision, confirm: "fleet.conf" }, "bash -n: line 2: syntax error near unexpected token"],
    [{ text: BASE.replace(MANAGED_INCLUDE + "\n", ""), revision, confirm: "fleet.conf" }, `keep the managed agents line, as the last line: ${MANAGED_INCLUDE}`],
    [{ text: BASE.replace("FLEET_DIR=/f", "FLEET_DIR=/g"), revision, confirm: "fleet.conf" }, 'FLEET_DIR cannot change from the page (it is "/f"); change it on the host and restart the service'],
    [{ text: BASE.replace("FLEET=t", "FLEET=u"), revision, confirm: "fleet.conf" }, 'FLEET cannot change from the page (it is "t"); change it on the host and restart the service'],
    [{ text: add("REMOTE_SSH='ssh x'"), revision, confirm: "fleet.conf" }, 'REMOTE_SSH cannot change from the page (it is ""); change it on the host and restart the service'],
    [{ text: add("exit 7"), revision, confirm: "fleet.conf" }, "fleet.conf does not load: sourcing it failed"],
  ];
  for (const [body, message] of cases) {
    const e = await fail(use.saveConf(body));
    expect([e.kind, e.message]).toEqual(["invalid", message]);
  }
  expect(state.text).toBe(BASE);
  expect(calls).toEqual([]);
});

test("logs take a known source and a bounded line count", async () => {
  const { host, state, calls } = fakeHost();
  state.logs = "a\nb\n";
  const use = adminUseCases({ host }, operator);
  expect(await use.log("watchdog", null)).toEqual({ source: "watchdog", lines: 200, text: "a\nb\n" });
  expect(await use.log("service", "50")).toEqual({ source: "service", lines: 50, text: "a\nb\n" });
  for (const [source, lines, message] of [[null, null, "source must be one of watchdog, service"], ["shell", null, "source must be one of watchdog, service"], ["watchdog", "0", "lines must be between 1 and 1000"], ["watchdog", "1001", "lines must be between 1 and 1000"], ["watchdog", "5;x", "lines must be between 1 and 1000"]] as const) {
    expect((await fail(use.log(source, lines))).message).toBe(message);
  }
  expect(calls).toEqual(["log watchdog 200", "log service 50"]);
});

test("a restart takes a fleet.conf session typed in full, never a managed agent, and reports a failed start", async () => {
  const { host, state, calls } = fakeHost(BASE.replace('"probe-shell|Probe|p.txt"', '"probe-shell|Probe|p.txt" "fc-x|X|x.txt"'));
  const use = adminUseCases({ host }, operator);
  const refusals: [string, unknown, string, string][] = [
    ["probe-shell", {}, "invalid", "type probe-shell to confirm the restart"],
    ["probe-shell", { confirm: "probe" }, "invalid", "type probe-shell to confirm the restart"],
    ["fc-x", { confirm: "fc-x" }, "invalid", "fc-x is a managed agent; stop and start it from the agent list"],
    ["nobody", { confirm: "nobody" }, "not_found", "nobody is not in fleet.conf, not running on the fleet's tmux server and has no saved start command"],
    ["../x", { confirm: "../x" }, "invalid", "bad session name"],
  ];
  for (const [s, body, kind, message] of refusals) {
    const e = await fail(use.restart(s, body));
    expect([e.kind, e.message]).toEqual([kind, message]);
  }
  expect(calls).toEqual([]);
  expect(await use.restart("probe-shell", { confirm: "probe-shell" })).toEqual({ session: "probe-shell", output: "probe-shell: started\n" });
  state.restartOk = false;
  const e = await fail(use.restart("probe-shell", { confirm: "probe-shell" }));
  expect([e.kind, e.message]).toEqual(["failed", "the old probe-shell session ended, and it did not start again: probe-shell: start FAILED: claude UI not detected after 90 s"]);
  // tmux could not end the old session: nothing was started and the old one may still run.
  state.restartStage = "kill";
  const k = await fail(use.restart("probe-shell", { confirm: "probe-shell" }));
  expect([k.kind, k.message]).toEqual(["unavailable", "probe-shell was not restarted; the old session may still be running: tmux kill-session failed: permission denied"]);
  // A start cut off at the time limit may have opened the session anyway.
  state.restartStage = "timeout";
  const t = await fail(use.restart("probe-shell", { confirm: "probe-shell" }));
  expect([t.kind, t.message]).toEqual(["unavailable", "the old probe-shell session ended, and its start did not finish in time; check its terminal: probe-shell: start FAILED: claude UI not detected after 90 s"]);
  state.restartStage = "start";
  expect(calls).toEqual(["restart probe-shell fleet-t", "restart probe-shell fleet-t", "restart probe-shell fleet-t", "restart probe-shell fleet-t"]);
});

test("review fixes: a broken current file, a lost managed agent, the include line moved, and a REMOTE_SSH restart are refused", async () => {
  const { host, state, calls } = fakeHost();
  const use = adminUseCases({ host }, operator);
  // The current file does not load: no values to compare against, so nothing is saved from the page.
  const broken = BASE + "exit 7\n";
  state.text = broken;
  let e = await fail(use.saveConf({ text: BASE, revision: revisionOf(broken), confirm: "fleet.conf" }));
  expect(e.message).toBe("the current fleet.conf does not load (sourcing it failed); fix it on the host");
  // A no-op save of a broken file answers without the load error.
  expect((await use.saveConf({ text: broken, revision: revisionOf(broken), confirm: "fleet.conf" })).backup).toBeNull();

  // The include line kept, but AGENTS reset after it: the managed agent fc-a falls out.
  state.text = BASE; state.managed = ["fc-a"];
  e = await fail(use.saveConf({ text: BASE + "AGENTS=()\n", revision: revisionOf(BASE), confirm: "fleet.conf" }));
  expect(e.message).toBe(`keep the managed agents line, as the last line: ${MANAGED_INCLUDE}`);
  // Same reset with the include line still last (the reset moved above a second copy): the loss itself is refused.
  e = await fail(use.saveConf({ text: BASE.replace(MANAGED_INCLUDE, "AGENTS=()") + "AGENTS=()\n" + MANAGED_INCLUDE + "\nAGENTS=()\n# end\n" , revision: revisionOf(BASE), confirm: "fleet.conf" }));
  expect(e.message).toBe(`keep the managed agents line, as the last line: ${MANAGED_INCLUDE}`);
  expect(calls).toEqual([]);

  // REMOTE_SSH fleets run their sessions elsewhere.
  state.text = BASE + "REMOTE_SSH='ssh x'\n" + MANAGED_INCLUDE + "\n";
  e = await fail(use.restart("probe-shell", { confirm: "probe-shell" }));
  expect([e.kind, e.message]).toEqual(["unavailable", "this fleet runs over REMOTE_SSH; restart its sessions on that host"]);
  expect(calls).toEqual([]);
});

test("a save that keeps the include line last but loses a managed agent is refused", async () => {
  const { host, state, calls } = fakeHost();
  state.managed = ["fc-a"];
  const use = adminUseCases({ host }, operator);
  // The fake loads managed agents unless the file ends in AGENTS=(); here the host reports the loss through facts.
  host.facts = async (t) => ({ fleet: "t", dir: "/f", socket: "fleet-t", remote: "", sessions: t.includes("DROP") ? ["probe-shell"] : ["probe-shell", "fc-a"] });
  const e = await fail(use.saveConf({ text: BASE.replace("AGENTS=(", "# DROP\nAGENTS=("), revision: revisionOf(BASE), confirm: "fleet.conf" }));
  expect(e.message).toBe("this edit drops the managed agents fc-a; keep the managed agents line last and do not reset AGENTS after it");
  expect(calls).toEqual([]);
});

test("a session that is not in fleet.conf restarts with the command an operator saved for it", async () => {
  const { host, state, calls } = fakeHost();
  const starts = new SessionStarts(new Store(":memory:").db);
  const now = () => new Date("2026-11-23T01:00:00Z");
  const use = adminUseCases({ host, starts, now }, operator);
  // probe-shell is in fleet.conf; hand is only running on the fleet's tmux server; fc-a is an agent and never listed.
  state.panes = [{ session: "probe-shell", command: "exec cat", cwd: "/f" }, { session: "hand", command: "", cwd: "/w" }, { session: "fc-a", command: "claude", cwd: "/a" }];
  expect(await use.sessions()).toEqual({ starts: true, sessions: [
    { session: "hand", inConf: false, running: true, saved: null, pane: { command: "", cwd: "/w" } },
    { session: "probe-shell", inConf: true, running: true, saved: null, pane: { command: "exec cat", cwd: "/f" } },
  ] });
  // Without a saved command a session outside fleet.conf cannot come back: fleet start would not know it.
  let e = await fail(use.restart("hand", { confirm: "hand" }));
  expect([e.kind, e.message]).toEqual(["invalid", "hand has no saved start command and is not in fleet.conf; save its start command first"]);
  const refusals: [string, unknown, string, string][] = [
    ["hand", { command: "x", cwd: "/w" }, "invalid", "type hand to confirm the start command"],
    ["hand", { command: "x", cwd: "w", confirm: "hand" }, "invalid", "folder must be an absolute path on the host"],
    ["hand", { command: "a\nb", cwd: "/w", confirm: "hand" }, "invalid", "command must be one line without control characters"],
    ["hand", { command: "x".repeat(1001), cwd: "/w", confirm: "hand" }, "invalid", "command may be at most 1000 characters"],
    ["hand", { command: "x", cwd: "/w", confirm: "hand", env: {} }, "invalid", "unknown field env"],
    ["fc-a", { command: "x", cwd: "/w", confirm: "fc-a" }, "invalid", "fc-a is a managed agent; stop and start it from the agent list"],
    ["ghost", { command: "x", cwd: "/w", confirm: "ghost" }, "not_found", "ghost is not in fleet.conf and not running on the fleet's tmux server"],
  ];
  for (const [s, body, kind, message] of refusals) {
    const r = await fail(use.saveStart(s, body));
    expect([r.kind, r.message]).toEqual([kind, message]);
  }
  expect(starts.list()).toEqual([]);
  const saved = await use.saveStart("hand", { command: "  exec sleep 600 ", cwd: "/w", confirm: "hand" });
  expect(saved).toEqual({ saved: { session: "hand", command: "exec sleep 600", cwd: "/w", savedBy: "op", savedAt: "2026-11-23T01:00:00.000Z" } });
  expect(await use.restart("hand", { confirm: "hand" })).toEqual({ session: "hand", output: "hand: started\n" });
  // A saved session stays restartable after it died: it is still listed.
  state.panes = [];
  expect((await use.sessions()).sessions.map((r) => [r.session, r.running, r.saved?.command ?? null])).toEqual([["hand", false, "exec sleep 600"], ["probe-shell", false, null]]);
  expect(await use.restart("hand", { confirm: "hand" })).toEqual({ session: "hand", output: "hand: started\n" });
  // A saved start wins over fleet.conf for a fleet.conf session too.
  await use.saveStart("probe-shell", { command: "exec cat", cwd: "/f", confirm: "probe-shell" });
  await use.restart("probe-shell", { confirm: "probe-shell" });
  // Removing it brings fleet start back for that session.
  e = await fail(use.removeStart("probe-shell", "probe"));
  expect(e.message).toBe("type probe-shell to confirm removing its start command");
  expect(await use.removeStart("probe-shell", "probe-shell")).toEqual({ removed: "probe-shell" });
  await use.restart("probe-shell", { confirm: "probe-shell" });
  expect((await fail(use.removeStart("probe-shell", "probe-shell"))).kind).toBe("not_found");
  expect(calls).toEqual(["restart hand fleet-t [/w] exec sleep 600", "restart hand fleet-t [/w] exec sleep 600", "restart probe-shell fleet-t [/f] exec cat", "restart probe-shell fleet-t"]);
  // Only an operator sees or changes saved starts.
  for (const role of ["agent", "viewer"] as const) {
    const other = adminUseCases({ host, starts, now }, { name: "x", role });
    expect((await fail(other.sessions())).constructor.name).toBe("RoleError");
    expect((await fail(other.saveStart("hand", { command: "x", cwd: "/w", confirm: "hand" }))).constructor.name).toBe("RoleError");
    expect((await fail(other.removeStart("hand", "hand"))).constructor.name).toBe("RoleError");
  }
  // A host without the store says so instead of pretending.
  const bare = adminUseCases({ host }, operator);
  expect((await bare.sessions()).starts).toBe(false);
  expect((await fail(bare.saveStart("hand", { command: "x", cwd: "/w", confirm: "hand" }))).message).toBe("saved start commands are not set up on this host");
});
