import { expect, test } from "bun:test";
import { tmuxLeaseTerminal, type Run } from "./lease-terminal.ts";

// A stand-in for tmux and pgrep that records every call and answers from a table.
function fake(answers: (argv: string[]) => Partial<Run>) {
  const calls: string[][] = [];
  const runner = async (argv: string[]) => { calls.push(argv); return { exitCode: 0, stdout: "", stderr: "", ...answers(argv) }; };
  return { calls, runner };
}

test("instance is one list-sessions call: id, creation time and active pane pid; a new agent window is a new instance", async () => {
  let pane = "900";
  const f = fake((a) => a.includes("list-sessions") ? { stdout: `probe-2 $9:1:1\nprobe $3:1795194451:${pane}\nother $4:1:2\n` } : {});
  const t = tmuxLeaseTerminal("fleet-x", "/bin/tmux", f.runner);
  expect(await t.instance("probe")).toBe("$3:1795194451:900");
  // agent-fleet restarts an agent in a new window; tmux then reports that window's pane.
  pane = "950";
  expect(await t.instance("probe")).toBe("$3:1795194451:950");
  expect(await t.instance("gone")).toBeNull();
  expect(f.calls.every((a) => a.includes("list-sessions"))).toBe(true);
  expect(f.calls).toHaveLength(3);
});

test("no tmux server means no session; any other tmux failure throws instead of ending a lease", async () => {
  const none = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ exitCode: 1, stderr: "error connecting to /tmp/tmux-501/fleet-x (No such file or directory)" })).runner);
  expect(await none.instance("probe")).toBeNull();
  const down = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ exitCode: 1, stderr: "no server running on /tmp/tmux-1000/fleet-x" })).runner);
  expect(await down.instance("probe")).toBeNull();
  const killed = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ exitCode: 137, stderr: "" })).runner);
  await expect(killed.instance("probe")).rejects.toThrow("tmux could not be asked: exit 137");
  const odd = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ stdout: "probe garbage\n" })).runner);
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
