import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeObserver,
  findClaude,
  lastMainModel,
  projectDirName,
  psProcesses,
  tmuxPanePids,
  type ProcessInfo,
} from "./claude.ts";

const line = (o: object) => JSON.stringify(o);
const asst = (model: string, at: string, extra: object = {}) =>
  line({ type: "assistant", sessionId: "s1", timestamp: at, isSidechain: false, message: { model }, ...extra });

test("project folder name matches Claude Code's encoding", () => {
  expect(projectDirName("/Users/me/Development/fleet-control/.agents/worktrees/x_y")).toBe(
    "-Users-me-Development-fleet-control--agents-worktrees-x-y",
  );
});

test("the newest claude child of a pane is chosen, other processes ignored", () => {
  const procs: ProcessInfo[] = [
    { pid: 10, ppid: 1, started: "", args: "claude" },
    { pid: 20, ppid: 5, started: "", args: "claude --model x" },
    { pid: 30, ppid: 5, started: "", args: "claude" },
    { pid: 40, ppid: 5, started: "", args: "claude-helper" },
    { pid: 50, ppid: 5, started: "", args: "node claude" },
  ];
  expect(findClaude([5], procs)?.pid).toBe(30);
  expect(findClaude([6], procs)).toBeNull();
});

test("last main-thread model wins; subagent and synthetic turns never overwrite it", () => {
  const tail = [
    '{"cut line',
    asst("model-a", "2026-11-09T10:00:00Z"),
    asst("model-b", "2026-11-09T10:01:00Z"),
    asst("child-model", "2026-11-09T10:02:00Z", { isSidechain: true }),
    asst("<synthetic>", "2026-11-09T10:03:00Z"),
    line({ type: "user", sessionId: "s1", timestamp: "2026-11-09T10:04:00Z" }),
    '{"type":"assistant","torn',
  ].join("\n");
  expect(lastMainModel(tail, "s1")).toEqual({ model: "model-b", at: "2026-11-09T10:01:00Z" });
});

test("a model switch shows up as the newer model", () => {
  const tail = [asst("model-a", "2026-11-09T10:00:00Z"), asst("model-c", "2026-11-09T10:05:00Z")].join("\n");
  expect(lastMainModel(tail, "s1")).toEqual({ model: "model-c", at: "2026-11-09T10:05:00Z" });
});

test("missing and malformed metadata are different outcomes", () => {
  expect(lastMainModel(line({ type: "user", sessionId: "s1" }), "s1")).toBeNull();
  expect(lastMainModel("", "s1")).toBeNull();
  expect(lastMainModel(line({ type: "assistant", sessionId: "s1", timestamp: "2026-11-09T10:00:00Z", message: {} }), "s1"))
    .toEqual({ malformed: "assistant record without a model or timestamp" });
  expect(lastMainModel("not json at all", "s1")).toEqual({ malformed: "transcript tail has no JSON records" });
});

test("records from another session id are ignored", () => {
  expect(lastMainModel(asst("model-a", "2026-11-09T10:00:00Z", { sessionId: "other" }), "s1")).toBeNull();
});

// --- observer with a fake host -------------------------------------------------

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fleet-control-test-observe-"));
  await mkdir(join(dir, "sessions"));
});
afterAll(async () => {
  if (dir.includes("fleet-control-test-")) await rm(dir, { recursive: true, force: true });
});

const START = "Mon Nov  9 12:41:09 2026";
function observer(procs: ProcessInfo[], panes: number[] | null = [7]) {
  return new ClaudeObserver({ configDir: dir, panePids: async () => panes, processes: async () => procs });
}
async function writeMeta(pid: number, meta: object) {
  await Bun.write(join(dir, "sessions", `${pid}.json`), JSON.stringify(meta));
}
async function writeTranscript(cwd: string, sessionId: string, body: string) {
  await Bun.write(join(dir, "projects", projectDirName(cwd), `${sessionId}.jsonl`), body);
}

test("observer: shell-only pane is no agent process, missing tmux session is unavailable", async () => {
  expect(await observer([{ pid: 8, ppid: 7, started: START, args: "sleep 10" }]).observe("x")).toEqual({ kind: "no_agent_process" });
  expect((await observer([], null).observe("x")).kind).toBe("unavailable");
});

test("observer: full chain gives the model bound to pid and session id", async () => {
  await writeMeta(101, { pid: 101, sessionId: "s1", cwd: "/w/a", procStart: START });
  await writeTranscript("/w/a", "s1", asst("model-b", "2026-11-09T10:01:00Z") + "\n");
  const o = await observer([{ pid: 101, ppid: 7, started: START, args: "claude" }]).observe("x");
  expect(o).toEqual({
    kind: "observed",
    runtimeInstance: "claude:101:s1",
    observation: { model: "model-b", source: "claude-code transcript", observedAt: "2026-11-09T10:01:00Z", runtimeInstance: "claude:101:s1" },
  });
});

test("observer: a reused pid with an older session file is not trusted", async () => {
  await writeMeta(102, { pid: 102, sessionId: "s1", cwd: "/w/a", procStart: "Sun Nov  8 01:00:00 2026" });
  const o = await observer([{ pid: 102, ppid: 7, started: START, args: "claude" }]).observe("x");
  expect(o.kind).toBe("unavailable");
});

test("observer: no transcript yet is a live instance with no turn, not an error", async () => {
  await writeMeta(103, { pid: 103, sessionId: "s3", cwd: "/w/b", procStart: START });
  expect(await observer([{ pid: 103, ppid: 7, started: START, args: "claude" }]).observe("x"))
    .toEqual({ kind: "no_turn_yet", runtimeInstance: "claude:103:s3" });
});

test("observer: broken session file is malformed, absent one is unavailable", async () => {
  await Bun.write(join(dir, "sessions", "104.json"), "{nope");
  expect((await observer([{ pid: 104, ppid: 7, started: START, args: "claude" }]).observe("x")).kind).toBe("malformed");
  expect((await observer([{ pid: 105, ppid: 7, started: START, args: "claude" }]).observe("x")).kind).toBe("unavailable");
});

// --- real tmux and ps, no model involved ----------------------------------------

test("real host: tmux pane pid and ps lstart line up with a fake claude child", async () => {
  const socket = `fleet-fctestobs${process.pid}`;
  const tmux = (...a: string[]) => Bun.spawn(["tmux", "-L", socket, "-f", "/dev/null", ...a], { stdout: "pipe", stderr: "ignore" });
  // the pane's shell starts a child whose argv[0] is "claude"; it is only `sleep`
  await tmux("new-session", "-d", "-s", "agent", "-x", "80", "-y", "20", "bash -c 'exec -a claude sleep 60' & wait").exited;
  try {
    let child: ProcessInfo | null = null;
    for (let i = 0; i < 40 && !child; i++) {
      const panes = (await tmuxPanePids(socket)("agent")) ?? [];
      child = findClaude(panes, await psProcesses());
      if (!child) await Bun.sleep(50);
    }
    expect(child).not.toBeNull();
    expect(child!.started).toMatch(/^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
    expect(await tmuxPanePids(socket)("missing")).toBeNull();

    await writeMeta(child!.pid, { pid: child!.pid, sessionId: "real", cwd: "/w/real", procStart: child!.started });
    await writeTranscript("/w/real", "real", line({ type: "assistant", sessionId: "real", timestamp: "2026-11-09T11:00:00Z", isSidechain: false, message: { model: "fixture-model" } }));
    const o = await new ClaudeObserver({ configDir: dir, panePids: tmuxPanePids(socket), processes: psProcesses }).observe("agent");
    expect(o.kind).toBe("observed");
    if (o.kind === "observed") expect(o.runtimeInstance).toBe(`claude:${child!.pid}:real`);
  } finally {
    await tmux("kill-server").exited;
    await rm(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.()}`, socket), { force: true });
  }
});
