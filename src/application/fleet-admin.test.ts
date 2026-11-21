import { expect, test } from "bun:test";
import { adminUseCases, revisionOf, type ConfFacts, type FleetHost } from "./fleet-admin.ts";
import { AdminError, MANAGED_INCLUDE } from "../domain/fleet-admin.ts";

const BASE = `FLEET=t\nFLEET_DIR=/f\nAGENTS=("probe-shell|Probe|p.txt")\n${MANAGED_INCLUDE}\n`;

// A host whose file lives in memory. facts() reads FLEET, FLEET_DIR and the session names the way bash would for these simple files.
function fakeHost(initial = BASE) {
  const calls: string[] = [];
  const state = { text: initial, backups: [] as string[], restartOk: true, logs: "" };
  const facts = (text: string): ConfFacts => {
    if (text.includes("exit 7")) throw new Error("sourcing it failed");
    const get = (k: string) => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "";
    return { fleet: get("FLEET"), dir: get("FLEET_DIR"), socket: `fleet-${get("FLEET")}`, remote: get("REMOTE_SSH"), sessions: [...text.matchAll(/"([A-Za-z0-9._-]+)\|/g)].map((m) => m[1]!) };
  };
  const host: FleetHost = {
    path: "/f/fleet.conf",
    read: async () => state.text,
    syntax: async (t) => (t.includes("((") ? "line 2: syntax error near unexpected token" : null),
    facts: async (t) => facts(t),
    replace: async (current, t) => { calls.push("replace"); expect(current).toBe(state.text); state.backups.push(state.text); state.text = t; return `/f/fleet.conf.bak-${state.backups.length}`; },
    log: async (source, lines) => { calls.push(`log ${source} ${lines}`); return state.logs; },
    restart: async (s) => { calls.push(`restart ${s}`); return { ok: state.restartOk, output: state.restartOk ? `${s}: started\n` : `${s}: start FAILED: claude UI not detected after 90 s\n` }; },
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
  const cases: [unknown, string][] = [
    [{ text: BASE + "x=1\n", revision }, "type fleet.conf to confirm the save"],
    [{ text: BASE + "x=1\n", revision, confirm: "fleet.conf", extra: 1 }, "unknown field extra"],
    [{ text: BASE, revision: "abc", confirm: "fleet.conf" }, "revision must be the SHA-256 the file was read with"],
    [{ text: "x".repeat(32 * 1024 + 1), revision, confirm: "fleet.conf" }, "fleet.conf may be at most 32768 bytes"],
    [{ text: BASE + "((\n", revision, confirm: "fleet.conf" }, "bash -n: line 2: syntax error near unexpected token"],
    [{ text: BASE.replace(MANAGED_INCLUDE + "\n", ""), revision, confirm: "fleet.conf" }, `keep the managed agents line: ${MANAGED_INCLUDE}`],
    [{ text: BASE.replace("FLEET_DIR=/f", "FLEET_DIR=/g"), revision, confirm: "fleet.conf" }, 'FLEET_DIR cannot change from the page (it is "/f"); change it on the host and restart the service'],
    [{ text: BASE.replace("FLEET=t", "FLEET=u"), revision, confirm: "fleet.conf" }, 'FLEET cannot change from the page (it is "t"); change it on the host and restart the service'],
    [{ text: BASE + "REMOTE_SSH='ssh x'\n", revision, confirm: "fleet.conf" }, 'REMOTE_SSH cannot change from the page (it is ""); change it on the host and restart the service'],
    [{ text: BASE + "exit 7\n", revision, confirm: "fleet.conf" }, "fleet.conf does not load: sourcing it failed"],
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
    ["nobody", { confirm: "nobody" }, "not_found", "nobody is not a session in fleet.conf"],
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
  expect([e.kind, e.message]).toEqual(["unavailable", "probe-shell did not start again: probe-shell: start FAILED: claude UI not detected after 90 s"]);
  expect(calls).toEqual(["restart probe-shell", "restart probe-shell"]);
});
