import { expect, test } from "bun:test";
import { tmuxLeaseTerminal, type Run } from "./lease-terminal.ts";

// A stand-in for tmux and pgrep that records every call and answers from a table.
function fake(answers: (argv: string[]) => Partial<Run>) {
  const calls: string[][] = [];
  const runner = async (argv: string[]) => { calls.push(argv); return { exitCode: 0, stdout: "", stderr: "", ...answers(argv) }; };
  return { calls, runner };
}

test("instance names the pane and the program running in it, so an agent restarted in the same pane is a new instance", async () => {
  let child = "4242";
  const f = fake((a) => a.includes("list-sessions") ? { stdout: "probe\nother\n" }
    : a.includes("display-message") ? { stdout: "$3:1795194451:900\n" }
    : a[0] === "/usr/bin/pgrep" ? (child ? { stdout: `${child}\n` } : { exitCode: 1 }) : {});
  const t = tmuxLeaseTerminal("fleet-x", "/bin/tmux", f.runner, "/usr/bin/pgrep");
  expect(await t.instance("probe")).toBe("$3:1795194451:900:4242");
  expect(f.calls.find((a) => a[0] === "/usr/bin/pgrep")).toEqual(["/usr/bin/pgrep", "-o", "-P", "900"]);
  child = "5151";
  expect(await t.instance("probe")).toBe("$3:1795194451:900:5151");
  child = "";
  expect(await t.instance("probe")).toBe("$3:1795194451:900:-");
  // An absent session is null without asking for its pane.
  const before = f.calls.length;
  expect(await t.instance("gone")).toBeNull();
  expect(f.calls.slice(before).some((a) => a.includes("display-message"))).toBe(false);
});

test("no tmux server means no session; any other tmux failure throws instead of ending a lease", async () => {
  const none = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ exitCode: 1, stderr: "error connecting to /tmp/tmux-501/fleet-x (No such file or directory)" })).runner);
  expect(await none.instance("probe")).toBeNull();
  const down = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ exitCode: 1, stderr: "no server running on /tmp/tmux-1000/fleet-x" })).runner);
  expect(await down.instance("probe")).toBeNull();
  const killed = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake(() => ({ exitCode: 137, stderr: "" })).runner);
  await expect(killed.instance("probe")).rejects.toThrow("tmux could not be asked: exit 137");
  const odd = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake((a) => a.includes("list-sessions") ? { stdout: "probe\n" } : { stdout: "garbage" }).runner);
  await expect(odd.instance("probe")).rejects.toThrow("tmux could not describe probe");
  const pg = tmuxLeaseTerminal("fleet-x", "/bin/tmux", fake((a) => a.includes("list-sessions") ? { stdout: "probe\n" } : a.includes("display-message") ? { stdout: "$1:2:3" } : { exitCode: 3 }).runner, "/usr/bin/pgrep");
  await expect(pg.instance("probe")).rejects.toThrow("pgrep failed for pane 3");
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
