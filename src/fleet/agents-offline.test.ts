// The agent-fleet adapter for managed agents, with a stub `fleet` that records what it was given and a
// private tmux server standing in for the fleet's socket. Nothing here starts Claude Code.
import { afterAll, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTONOMY, FleetAgentLauncher, MANAGED_FILE, dshPatchFile } from "./agents.ts";

const base = await mkdtemp(join(tmpdir(), "fc-agents-"));
const socket = `fc-agents-test-${process.pid}`;
afterAll(async () => {
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"]);
  await rm(base, { recursive: true, force: true });
});
const fleetDir = join(base, "fleet");
const root = join(base, "fleet-agents");
await mkdir(fleetDir, { recursive: true });
await mkdir(join(root, "sandbox"), { recursive: true });
await mkdir(join(root, "other"), { recursive: true });
await mkdir(join(base, "outside"), { recursive: true });
await symlink(join(base, "outside"), join(root, "link-out"));
const confPath = join(fleetDir, "fleet.conf");
await writeFile(confPath, `FLEET=t\nFLEET_DIR=${fleetDir}\nFLEET_TMUX_SOCKET=${socket}\nAGENTS=("probe-shell|Probe|probe.txt")\n`);
// The fleet's synced watchdog; the launcher checks it supports agent_overrides.
await writeFile(join(fleetDir, "watchdog.sh"), "agent_cwd() { ( declare -F agent_overrides >/dev/null && agent_overrides \"$1\" ); }\nagent_kind() { :; }\n");
const claudeState = join(base, "claude.json");
await writeFile(claudeState, JSON.stringify({ projects: { "/keep": { hasTrustDialogAccepted: false, x: 1 } }, other: true }));

// The stub sources fleet.conf and asks agent_overrides for the session, as agent-fleet's watchdog does
// (scripts/watchdog.sh agent_cwd/agent_args), and records the result.
const log = join(base, "fleet-calls.log");
const fleetBin = join(base, "fleet-stub");
await writeFile(fleetBin, `#!/usr/bin/env bash
. "$FLEET_CONF"
[ -n "\${SLOW_START:-}" ] && sleep "$SLOW_START"
declare -F agent_overrides >/dev/null && agent_overrides "$2"
{ printf 'args=%s\\n' "$*"; printf 'AGENT_CWD=%s\\n' "\${AGENT_CWD:-}"; printf 'AGENT_KIND=%s\\n' "\${AGENT_KIND:-}"; printf 'DSH_ARGS=%s\\n' "\${DSH_ARGS:-}"; printf 'CLAUDE_ARGS=%s\\n' "\${CLAUDE_ARGS:-}"; printf 'AGENTS=%s\\n' "\${AGENTS[*]}"; } >> "${log}"
[ "\${FAIL_START:-}" = 1 ] && { echo "fc-x: start FAILED: claude UI not detected after 90 s" >&2; exit 1; }
tmux -L "$FLEET_TMUX_SOCKET" -f /dev/null new-session -d -s "$2" "sleep 300"
echo "$2: started"
`);
await chmod(fleetBin, 0o755);
const launcher = (env: Record<string, string> = {}) => new FleetAgentLauncher({ fleetBin, confPath, roots: [root], claudeState, env });

test("resolveDir accepts only real folders inside a root and follows symlinks before checking", async () => {
  const l = launcher();
  expect(await l.resolveDir(join(root, "sandbox"))).toBe(await (await import("node:fs/promises")).realpath(join(root, "sandbox")));
  for (const bad of [join(base, "outside"), join(root, "link-out"), root, join(root, "missing"), join(root, "sandbox", "..", "..", "outside")]) {
    await expect(l.resolveDir(bad)).rejects.toThrow(/inside|not an existing folder/);
  }
  // A symlink is not listed: the picker offers only real folders.
  expect(await l.folders()).toEqual([join(root, "other"), join(root, "sandbox")]);
});

test("start writes the prompt, hard limits, managed rows and trust, then runs fleet start; agent_overrides gives each agent its values", async () => {
  const l = launcher();
  const cwd = await l.resolveDir(join(root, "sandbox"));
  await l.start({ name: "fc-one", kind: "claude", cwd, model: "haiku", prompt: "Say READY." }, () => [{ name: "fc-one", kind: "claude", cwd, model: "haiku" }]);
  expect(await readFile(join(fleetDir, "fc-one.txt"), "utf8")).toBe("Say READY.\n");
  expect((await stat(join(fleetDir, "fc-one.txt"))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(fleetDir, "autonomy.txt"), "utf8")).toBe(AUTONOMY);
  const conf = await readFile(confPath, "utf8");
  expect(conf.startsWith(`FLEET=t\n`)).toBe(true);
  expect(conf).toContain(MANAGED_FILE);
  const calls = await readFile(log, "utf8");
  expect(calls).toContain("args=start fc-one");
  expect(calls).toContain(`AGENT_CWD=${cwd}`);
  expect(calls).toContain("CLAUDE_ARGS=--dangerously-skip-permissions --model haiku");
  expect(calls).toContain("AGENTS=probe-shell|Probe|probe.txt fc-one|Fleet: fc-one|fc-one.txt");
  const state = JSON.parse(await readFile(claudeState, "utf8"));
  expect(state.projects[cwd]).toEqual({ hasTrustDialogAccepted: true });
  expect(state.projects["/keep"]).toEqual({ hasTrustDialogAccepted: false, x: 1 });
  expect(state.other).toBe(true);
  expect(await l.running()).toEqual(new Set(["fc-one"]));

  // A second start leaves the include line single and keeps a hand-edited autonomy.txt.
  await writeFile(join(fleetDir, "autonomy.txt"), "own limits\n");
  const other = await l.resolveDir(join(root, "other"));
  await l.start({ name: "fc-two", kind: "claude", cwd: other, model: "opus", prompt: "x" }, () => [{ name: "fc-one", kind: "claude", cwd, model: "haiku" }, { name: "fc-two", kind: "claude", cwd: other, model: "opus" }]);
  expect((await readFile(confPath, "utf8")).split(MANAGED_FILE).length - 1).toBe(2);
  expect(await readFile(join(fleetDir, "autonomy.txt"), "utf8")).toBe("own limits\n");
  // Sourcing alone sets no folder or arguments; agent_overrides sets them per session, as the
  // watchdog asks on a replacement, and leaves other sessions alone.
  const ask = (s: string) => Bun.spawnSync(["bash", "-c", `. "${confPath}"; ${s ? `agent_overrides ${s}; ` : ""}printf '%s|%s|%s' "\${AGENTS[*]}" "\${AGENT_CWD:-}" "\${CLAUDE_ARGS:-}"`]).stdout.toString();
  const rows = "probe-shell|Probe|probe.txt fc-one|Fleet: fc-one|fc-one.txt fc-two|Fleet: fc-two|fc-two.txt";
  expect(ask("")).toBe(`${rows}||`);
  expect(ask("fc-one")).toBe(`${rows}|${cwd}|--dangerously-skip-permissions --model haiku`);
  expect(ask("fc-two")).toBe(`${rows}|${other}|--dangerously-skip-permissions --model opus`);
  expect(ask("probe-shell")).toBe(`${rows}||`);

  // Stop ends only the named session and drops its row.
  Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "probe-shell", "sleep 300"]);
  await l.stop("fc-one", () => [{ name: "fc-two", kind: "claude", cwd: other, model: "opus" }]);
  const after = Bun.spawnSync(["tmux", "-L", socket, "ls", "-F", "#{session_name}"]).stdout.toString().trim().split("\n").sort();
  expect(after).toEqual(["fc-two", "probe-shell"]);
  expect(await l.running()).toEqual(new Set(["fc-two"]));
  expect(await readFile(join(fleetDir, MANAGED_FILE), "utf8")).not.toContain("fc-one");
  // Stopping a session that is already gone is not an error.
  await l.stop("fc-one", () => [{ name: "fc-two", kind: "claude", cwd: other, model: "opus" }]);
});

test("a failed fleet start is reported with its last error line", async () => {
  const l = launcher({ FAIL_START: "1" });
  const cwd = await l.resolveDir(join(root, "sandbox"));
  await expect(l.start({ name: "fc-x", kind: "claude", cwd, model: "haiku", prompt: "x" }, () => [{ name: "fc-x", kind: "claude", cwd, model: "haiku" }]))
    .rejects.toThrow("fleet start exited 1: fc-x: start FAILED: claude UI not detected after 90 s");
});

test("a fleet that runs over ssh is refused before anything is written", async () => {
  await mkdir(join(base, "remote-dir"), { recursive: true });
  const remoteConf = join(base, "remote-dir", "fleet.conf");
  await writeFile(remoteConf, `FLEET=r\nFLEET_DIR=${join(base, "remote-dir")}\nREMOTE_SSH="ssh host"\nAGENTS=()\n`);
  const l = new FleetAgentLauncher({ fleetBin, confPath: remoteConf, roots: [root], claudeState });
  const cwd = await l.resolveDir(join(root, "sandbox"));
  await expect(l.start({ name: "fc-r", kind: "claude", cwd, model: "haiku", prompt: "x" }, () => [])).rejects.toThrow("REMOTE_SSH");
  expect(await Bun.file(join(base, "remote-dir", "fc-r.txt")).exists()).toBe(false);
});

test("the include is restored when its line is gone even if the comment stayed", async () => {
  const l = launcher();
  const conf = await readFile(confPath, "utf8");
  await writeFile(confPath, conf.split("\n").filter((line) => !line.includes(MANAGED_FILE)).join("\n"));
  expect(await readFile(confPath, "utf8")).toContain("# fleet-control managed agents");
  await l.rewrite(() => []);
  expect((await readFile(confPath, "utf8")).split("\n").filter((line) => line.includes(MANAGED_FILE))).toHaveLength(1);
  expect(await readFile(join(fleetDir, MANAGED_FILE), "utf8")).not.toContain("AGENTS+=");
});

test("an unreadable Claude Code state file stops the start before any file is written", async () => {
  const bad = join(base, "bad-claude.json");
  for (const text of ["{not json", "[1,2]", "null"]) {
    await writeFile(bad, text);
    const l = new FleetAgentLauncher({ fleetBin, confPath, roots: [root], claudeState: bad });
    const cwd = await l.resolveDir(join(root, "sandbox"));
    await expect(l.start({ name: "fc-bad", kind: "claude", cwd, model: "haiku", prompt: "x" }, () => [{ name: "fc-bad", kind: "claude", cwd, model: "haiku" }])).rejects.toThrow("could not be read");
    expect(await Bun.file(join(fleetDir, "fc-bad.txt")).exists()).toBe(false);
    expect(await readFile(join(fleetDir, MANAGED_FILE), "utf8")).not.toContain("fc-bad");
    expect(await readFile(bad, "utf8")).toBe(text);
  }
});

test("trust writes through a symlinked state file, keeps the link, and skips the write when already trusted", async () => {
  const real = join(base, "real-claude.json");
  const link = join(base, "link-claude.json");
  await writeFile(real, JSON.stringify({ projects: {} }));
  await symlink(real, link);
  const l = new FleetAgentLauncher({ fleetBin, confPath, roots: [root], claudeState: link });
  const cwd = await l.resolveDir(join(root, "other"));
  await l.start({ name: "fc-link", kind: "claude", cwd, model: "haiku", prompt: "x" }, () => [{ name: "fc-link", kind: "claude", cwd, model: "haiku" }]);
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(JSON.parse(await readFile(real, "utf8")).projects[cwd]).toEqual({ hasTrustDialogAccepted: true });
  // Already trusted: the file is not rewritten (a compact layout stays compact).
  await writeFile(real, JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  const before = await readFile(real, "utf8");
  await l.stop("fc-link", () => []);
  await l.start({ name: "fc-link", kind: "claude", cwd, model: "haiku", prompt: "x" }, () => [{ name: "fc-link", kind: "claude", cwd, model: "haiku" }]);
  expect(await readFile(real, "utf8")).toBe(before);
  expect(await Bun.file(`${real}.fleet-control.lock`).exists()).toBe(false);
  await l.stop("fc-link", () => []);
});

test("a stop does not wait for another agent's start that is still running", async () => {
  const l = launcher({ SLOW_START: "3" });
  const cwd = await l.resolveDir(join(root, "sandbox"));
  const starting = l.start({ name: "fc-slow", kind: "claude", cwd, model: "haiku", prompt: "x" }, () => [{ name: "fc-slow", kind: "claude", cwd, model: "haiku" }]);
  await Bun.sleep(300);
  const t0 = Date.now();
  await l.stop("fc-gone", () => [{ name: "fc-slow", kind: "claude", cwd, model: "haiku" }]);
  expect(Date.now() - t0).toBeLessThan(2000);
  await starting;
  await l.stop("fc-slow", () => []);
});

test("the folder picker leaves out folders the start would refuse", async () => {
  await mkdir(join(root, "has space"), { recursive: true });
  try {
    expect(await launcher().folders()).toEqual([join(root, "other"), join(root, "sandbox")]);
  } finally {
    await rm(join(root, "has space"), { recursive: true, force: true });
  }
});

test("a fleet whose watchdog does not know agent_overrides is refused before anything is written", async () => {
  const oldDir = join(base, "old-fleet");
  await mkdir(oldDir, { recursive: true });
  const oldConf = join(oldDir, "fleet.conf");
  await writeFile(oldConf, `FLEET=o\nFLEET_DIR=${oldDir}\nFLEET_TMUX_SOCKET=${socket}\nAGENTS=()\n`);
  // agent-fleet 0.4.0 launches with the fleet's AGENT_CWD and CLAUDE_ARGS only.
  await writeFile(join(oldDir, "watchdog.sh"), 'launch "$s" "${AGENT_CWD:-$HOME}"\n');
  const l = new FleetAgentLauncher({ fleetBin, confPath: oldConf, roots: [root], claudeState });
  const cwd = await l.resolveDir(join(root, "sandbox"));
  await expect(l.start({ name: "fc-old", kind: "claude", cwd, model: "haiku", prompt: "x" }, () => [{ name: "fc-old", kind: "claude", cwd, model: "haiku" }]))
    .rejects.toThrow("does not support agent_overrides");
  expect(await Bun.file(join(oldDir, "fc-old.txt")).exists()).toBe(false);
  expect(await Bun.file(join(oldDir, MANAGED_FILE)).exists()).toBe(false);
});

test("a FLEET_CONF that is not the fleet's own fleet.conf is refused", async () => {
  const elsewhere = join(base, "elsewhere.conf");
  await writeFile(elsewhere, `FLEET=t\nFLEET_DIR=${fleetDir}\nFLEET_TMUX_SOCKET=${socket}\nAGENTS=()\n`);
  const l = new FleetAgentLauncher({ fleetBin, confPath: elsewhere, roots: [root], claudeState });
  await expect(l.rewrite(() => [])).rejects.toThrow("FLEET_CONF is not $FLEET_DIR/fleet.conf");
  expect(await readFile(elsewhere, "utf8")).not.toContain(MANAGED_FILE);
});

test("an include line with trailing spaces or CRLF is not added twice", async () => {
  const l = launcher();
  const lines = (await readFile(confPath, "utf8")).split("\n").map((line) => (line.includes(MANAGED_FILE) ? `${line}  \r` : line));
  await writeFile(confPath, lines.join("\n"));
  await l.rewrite(() => []);
  expect((await readFile(confPath, "utf8")).split("\n").filter((line) => line.includes(MANAGED_FILE))).toHaveLength(1);
});

test("the pinned agent-fleet watchdog passes the launcher's agent_overrides check", async () => {
  const pinned = await readFile(join(import.meta.dir, "..", "..", "vendor", "agent-fleet", "scripts", "watchdog.sh"), "utf8");
  expect(pinned).toContain("agent_overrides");
});

test("a DSH agent gets kind dsh, its own patch file and no Claude Code trust; the next agent keeps its own kind", async () => {
  const l = launcher();
  // A folder no earlier test trusted, so a trust entry written for it would show.
  await mkdir(join(root, "deep"), { recursive: true });
  const cwd = await l.resolveDir(join(root, "deep"));
  const before = await readFile(claudeState, "utf8");
  await writeFile(log, "");
  const rows = () => [{ name: "fc-deep", kind: "dsh" as const, cwd, model: "deepseek-official/deepseek-flash" }, { name: "fc-plain", kind: "claude" as const, cwd, model: "haiku" }];
  await l.start({ name: "fc-deep", kind: "dsh", cwd, model: "deepseek-official/deepseek-flash", prompt: "Say READY." }, rows);
  const patch = join(fleetDir, dshPatchFile("fc-deep"));
  expect(await readFile(patch, "utf8")).toBe([
    "# Written by Fleet Control for one managed DSH agent.", "- id: credentials", "  disabled: false",
    "- id: agent-default-model", '  name: "@deepseek-ai/dsh-agent-default-model"', "  config:",
    "    provider: deepseek-official", "    model: deepseek-flash", "",
  ].join("\n"));
  expect((await stat(patch)).mode & 0o777).toBe(0o600);
  // No key is written anywhere by Fleet Control: the patch only turns DSH's own store on.
  expect(await readFile(patch, "utf8")).not.toMatch(/key|token|secret/i);
  const calls = await readFile(log, "utf8");
  expect(calls).toContain("AGENT_KIND=dsh");
  expect(calls).toContain(`DSH_ARGS=--patch ${patch} --permission-mode workspace-write`);
  expect(calls).toContain(`AGENT_CWD=${cwd}`);
  // DSH needs no Claude Code trust entry.
  expect(await readFile(claudeState, "utf8")).toBe(before);
  // The Claude row in the same file still says claude, so a value set for the DSH agent cannot carry over.
  const managed = await readFile(join(fleetDir, MANAGED_FILE), "utf8");
  expect(managed).toContain("fc-plain) AGENT_CWD=" + cwd + '; AGENT_KIND=claude; CLAUDE_ARGS="--dangerously-skip-permissions --model haiku" ;;');
  await l.stop("fc-deep", () => []);
});

test("a DSH start on a watchdog without a per-agent kind is refused before anything is written", async () => {
  const oldDir = join(base, "kindless-fleet");
  await mkdir(oldDir, { recursive: true });
  const oldConf = join(oldDir, "fleet.conf");
  await writeFile(oldConf, `FLEET=k\nFLEET_DIR=${oldDir}\nFLEET_TMUX_SOCKET=${socket}\nAGENTS=()\n`);
  // agent-fleet 0.5.0: agent_overrides for folder and Claude arguments, kind fleet-wide only.
  await writeFile(join(oldDir, "watchdog.sh"), "agent_cwd() { ( declare -F agent_overrides >/dev/null && agent_overrides \"$1\" ); }\n");
  const l = new FleetAgentLauncher({ fleetBin, confPath: oldConf, roots: [root], claudeState });
  const cwd = await l.resolveDir(join(root, "sandbox"));
  await expect(l.start({ name: "fc-k", kind: "dsh", cwd, model: "deepseek-official/deepseek-flash", prompt: "x" }, () => [{ name: "fc-k", kind: "dsh", cwd, model: "deepseek-official/deepseek-flash" }]))
    .rejects.toThrow("does not support a per-agent kind");
  for (const f of ["fc-k.txt", dshPatchFile("fc-k"), MANAGED_FILE]) expect(await Bun.file(join(oldDir, f)).exists()).toBe(false);
});
