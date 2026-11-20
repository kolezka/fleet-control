import { expect, test } from "bun:test";
import { tmuxLeaseTerminal, type Run } from "./lease-terminal.ts";

// A stand-in for tmux and pgrep that records every call and answers from a table.
function fake(answers: (argv: string[]) => Partial<Run>) {
  const calls: string[][] = [];
  const runner = async (argv: string[]) => { calls.push(argv); return { exitCode: 0, stdout: "", stderr: "", ...answers(argv) }; };
  return { calls, runner };
}

test("instance is one list-sessions call: id, creation time, active pane pid and shell or app; a new agent window is a new instance", async () => {
  let pane = "900";
  let command = "claude";
  // tmux filters by the exact name; the stand-in answers only for "probe", as tmux would.
  const f = fake((a) => a.includes("list-sessions") ? { stdout: a.includes("#{==:#{session_name},probe}") ? `$3:1795194451:${pane} ${command}\n` : "" } : {});
  const t = tmuxLeaseTerminal("fleet-x", "/bin/tmux", f.runner);
  expect(await t.instance("probe")).toBe("$3:1795194451:900:app");
  // The agent exits and the pane shows its shell (login shells appear as -zsh).
  command = "-zsh";
  expect(await t.instance("probe")).toBe("$3:1795194451:900:shell");
  // agent-fleet restarts an agent in a new window; tmux then reports that window's pane.
  pane = "950"; command = "node";
  expect(await t.instance("probe")).toBe("$3:1795194451:950:app");
  expect(await t.instance("gone")).toBeNull();
  expect(f.calls.every((a) => a.includes("list-sessions"))).toBe(true);
  expect(f.calls[0]).toContain("#{==:#{session_name},probe}");
  expect(f.calls).toHaveLength(4);
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

test("real tmux: a pane whose program exits to a shell reads as shell, and only the exact session name matches", async () => {
  const socket = `fc-lt-${process.pid}`;
  const tmuxBin = Bun.which("tmux", { PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/bin` });
  if (!tmuxBin) { console.warn("SKIP: no tmux"); return; }
  const tm = (...a: string[]) => Bun.spawnSync([tmuxBin, "-L", socket, "-f", "/dev/null", ...a]);
  try {
    // As agent-fleet does it: a shell pane, the agent command typed into it. Here the "agent" ends after 2 s.
    tm("new-session", "-d", "-s", "agent", "sh");
    await Bun.sleep(300);
    tm("send-keys", "-t", "=agent:", "sleep 2", "Enter");
    await Bun.sleep(500);
    tm("new-session", "-d", "-s", "agent x", "sleep 30");
    tm("new-session", "-d", "-s", "agent-2", "sh");
    const t = tmuxLeaseTerminal(socket, tmuxBin);
    const first = await t.instance("agent");
    expect(first).toMatch(/^\$\d+:\d+:\d+:app$/);
    await Bun.sleep(2200);
    const after = await t.instance("agent");
    expect(after).toBe(first!.replace(/:app$/, ":shell"));
    expect(await t.instance("agent-2")).toMatch(/:shell$/);
    expect(await t.instance("agen")).toBeNull();
  } finally {
    tm("kill-server");
  }
});
