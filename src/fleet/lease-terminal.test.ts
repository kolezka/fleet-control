import { expect, test } from "bun:test";
import { SHELL, tmuxLeaseTerminal, type Run } from "./lease-terminal.ts";

// A stand-in for tmux and pgrep that records every call and answers from a table.
function fake(answers: (argv: string[]) => Partial<Run>) {
  const calls: string[][] = [];
  const runner = async (argv: string[]) => { calls.push(argv); return { exitCode: 0, stdout: "", stderr: "", ...answers(argv) }; };
  return { calls, runner };
}

test("instance: id, creation time, active pane pid, and shell or app from the pane's process, foreground and own group; a new agent window is a new instance", async () => {
  let pane = "900";
  // pid ppid pgid tpgid comm
  let table = "  900     1   900   901 -zsh\n  901   900   901   901 node\n";
  // tmux filters by the exact name; the stand-in answers only for "probe", as tmux would.
  const f = fake((a) => a.includes("list-sessions")
    ? { stdout: a.includes("#{==:#{session_name},probe}") ? `$3:1795194451:${pane}\n` : "" }
    : a[0] === "/bin/ps" ? { stdout: table } : {});
  const t = tmuxLeaseTerminal("fleet-x", "/bin/tmux", f.runner, "/bin/ps");
  // A job-control shell ran the agent in its own group.
  expect(await t.instance("probe")).toBe("$3:1795194451:900:app");
  // The agent exits: the pane's shell has the foreground again.
  table = "  900     1   900   900 -zsh\n";
  expect(await t.instance("probe")).toBe("$3:1795194451:900:shell");
  // A background job of that shell has its own group: still a prompt.
  table = "  900     1   900   900 -zsh\n  905   900   905   900 sleep\n";
  expect(await t.instance("probe")).toBe("$3:1795194451:900:shell");
  // A pane started with a command (no job control): the child stays in the pane's group.
  table = "  900     1   900   900 bash\n  902   900   900   900 claude\n";
  expect(await t.instance("probe")).toBe("$3:1795194451:900:app");
  // A pane whose own process is the program, with or without children of its own.
  table = "  900     1   900   900 claude\n";
  expect(await t.instance("probe")).toBe("$3:1795194451:900:app");
  table = "  900     1   900   900 /usr/bin/bash\n";
  expect(await t.instance("probe")).toBe("$3:1795194451:900:shell");
  // agent-fleet restarts an agent in a new window; tmux then reports that window's pane.
  pane = "950"; table = "  950     1   950   960 zsh\n  960   950   960   960 node\n";
  expect(await t.instance("probe")).toBe("$3:1795194451:950:app");
  expect(await t.instance("gone")).toBeNull();
  expect(f.calls[0]).toContain("#{==:#{session_name},probe}");
  expect(f.calls.filter((a) => a[0] === "/bin/ps").every((a) => a.join(" ") === "/bin/ps -A -o pid=,ppid=,pgid=,tpgid=,comm=")).toBe(true);
  // ps that fails, or does not list the pane, is an error, never a guess.
  table = "  1  0  1  1 launchd\n";
  await expect(t.instance("probe")).rejects.toThrow("could not read the foreground of probe's pane 950");
  const failing = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake((a) => a.includes("list-sessions") ? { stdout: "$3:1:900\n" } : { exitCode: 1, stdout: "  900 1 900 900 zsh\n" }).runner, "/bin/ps");
  await expect(failing.instance("probe")).rejects.toThrow("could not read the foreground of probe's pane 900");
});

test("no tmux server means no session; any other tmux failure throws instead of ending a lease", async () => {
  const none = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ exitCode: 1, stderr: "error connecting to /tmp/tmux-501/fleet-x (No such file or directory)" })).runner);
  expect(await none.instance("probe")).toBeNull();
  const down = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ exitCode: 1, stderr: "no server running on /tmp/tmux-1000/fleet-x" })).runner);
  expect(await down.instance("probe")).toBeNull();
  const killed = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ exitCode: 137, stderr: "" })).runner);
  await expect(killed.instance("probe")).rejects.toThrow("tmux could not be asked: exit 137");
  const odd = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ stdout: "garbage\n" })).runner);
  await expect(odd.instance("probe")).rejects.toThrow("tmux could not describe probe");
});

test("a failed -S probe is asked again on the next paste instead of failing every paste", async () => {
  let fail = true;
  const runner = async (argv: string[]) => {
    if (argv.includes("list-commands") && fail) { fail = false; throw new Error("spawn failed"); }
    return { exitCode: 0, stdout: argv.includes("list-commands") ? "paste-buffer [-dprS]" : "", stderr: "" };
  };
  const t = tmuxLeaseTerminal("fleet-x", "/bin/tmux", runner);
  await expect(t.type("probe", new Uint8Array([1]))).rejects.toThrow("spawn failed");
  await t.type("probe", new Uint8Array([1]));
});

test("a paste adds -S only where tmux has it, asks once, and targets the session exactly", async () => {
  for (const [usage, flags] of [["paste-buffer (pasteb) [-dprS] [-s separator]", ["-S", "-d"]], ["paste-buffer (pasteb) [-dpr] [-s separator]", ["-d"]]] as const) {
    const f = fake((a) => a.includes("list-commands") ? { stdout: usage } : {});
    const t = tmuxLeaseTerminal("fleet-x", "/bin/tmux", f.runner);
    await t.type("probe", new Uint8Array([0x61, 0x03]));
    await t.type("probe", new Uint8Array([0x0d]));
    expect(f.calls.filter((a) => a.includes("list-commands"))).toHaveLength(1);
    const pastes = f.calls.filter((a) => a.includes("load-buffer"));
    expect(pastes).toHaveLength(2);
    const p = pastes[0]!;
    expect(p.slice(0, 5)).toEqual(["/bin/tmux", "-L", "fleet-x", "-f", "/dev/null"]);
    const i = p.indexOf("paste-buffer");
    expect(p.slice(i + 1, i + 1 + flags.length)).toEqual([...flags]);
    expect(p.slice(-2)).toEqual(["-t", "=probe:"]);
  }
  const t = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({})).runner);
  await expect(t.type("probe; kill-server", new Uint8Array([1]))).rejects.toThrow("bad session name");
});

// Waits for a tmux answer to change instead of sleeping a fixed time.
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await Bun.sleep(100);
  }
}

test("real tmux: an agent behind a wrapper script reads as app, its exit to the prompt as shell, a command-started pane or the program itself as app, a background job as shell, and only the exact session name matches", { timeout: 30_000 }, async () => {
  const socket = `fc-lt-${process.pid}`;
  const tmuxBin = Bun.which("tmux", { PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/bin` });
  if (!tmuxBin) { console.warn("SKIP: no tmux"); return; }
  const tm = (...a: string[]) => Bun.spawnSync([tmuxBin, "-L", socket, "-f", "/dev/null", ...a]);
  const dir = await (await import("node:fs/promises")).mkdtemp(`${(await import("node:os")).tmpdir()}/fc-lt-`);
  const wrapper = `${dir}/agent.sh`;
  // A wrapper that keeps bash in the foreground and runs the "agent" as its child, without exec.
  await Bun.write(wrapper, "#!/bin/bash\nsleep 3\ntrue\n");
  (await import("node:fs")).chmodSync(wrapper, 0o755);
  const t = tmuxLeaseTerminal(socket, tmuxBin);
  try {
    // Only "agent x" exists: asking for "agent" must not find it.
    tm("new-session", "-d", "-s", "agent x", "sleep 30");
    expect(await t.instance("agent")).toBeNull();
    // As agent-fleet does it: a shell pane, the agent command typed into it.
    tm("new-session", "-d", "-s", "agent", "sh");
    tm("new-session", "-d", "-s", "agent-2", "sh");
    // Right after new-session the pane's process may not have become the shell yet, so wait for it.
    expect(await until(() => t.instance("agent"), (v) => v?.endsWith(":shell") === true)).toMatch(/^\$\d+:\d+:\d+:shell$/);
    await until(() => t.instance("agent-2"), (v) => v?.endsWith(":shell") === true);
    tm("send-keys", "-t", "=agent:", wrapper, "Enter");
    const running = await until(() => t.instance("agent"), (v) => v?.endsWith(":app") === true);
    expect(running).toMatch(/^\$\d+:\d+:\d+:app$/);
    const after = await until(() => t.instance("agent"), (v) => v?.endsWith(":shell") === true);
    expect(after).toBe(running!.replace(/:app$/, ":shell"));
    expect(await t.instance("agent-2")).toMatch(/:shell$/);
    // A background job at the prompt is still a prompt.
    tm("send-keys", "-t", "=agent-2:", "sleep 300 &", "Enter");
    await Bun.sleep(500);
    expect(await t.instance("agent-2")).toMatch(/:shell$/);
    // A pane whose own process is the program reads as app while it runs.
    tm("new-session", "-d", "-s", "prog", "sleep 30");
    expect(await until(() => t.instance("prog"), (v) => v !== null)).toMatch(/:app$/);
    expect(await t.instance("agen")).toBeNull();
    // A pane started with a command has no job control; while its program runs it is not a shell prompt.
    tm("new-session", "-d", "-s", "cmd", "bash -c 'sleep 30; exec bash'");
    expect(await until(() => t.instance("cmd"), (v) => v?.endsWith(":app") === true)).toMatch(/:app$/);
  } finally {
    tm("kill-server");
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
});

test("the shell list: these names sit at a prompt, anything else is a program", () => {
  for (const n of ["sh", "ash", "bash", "rbash", "zsh", "fish", "dash", "ksh", "ksh93", "mksh", "oksh", "pdksh", "yash", "busybox", "tcsh", "csh", "nu", "xonsh", "pwsh"]) expect(SHELL.test(n), n).toBe(true);
  for (const n of ["claude", "node", "sleep", "bun", "zshx", "bash5", ""]) expect(SHELL.test(n), n).toBe(false);
});
