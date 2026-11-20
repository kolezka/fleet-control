// Managed agents over REST: only an operator starts or stops, the start is confirmed by name, the folder
// must be inside an allowed root, a token in the prompt is refused, and the row follows the launch.
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, parseTokens, tokenLine } from "./auth.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";
import { Agents } from "./data/agents.ts";
import { agentUseCases } from "./application/agents.ts";
import { AgentError, type AgentLauncher, type AgentSpec, type FleetRow } from "./domain/agents.ts";

const dir = await mkdtemp(join(tmpdir(), "agents-rest-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const root = join(dir, "fleet-agents");
await mkdir(join(root, "sandbox"), { recursive: true });
await mkdir(join(dir, "elsewhere"), { recursive: true });
await symlink(join(dir, "elsewhere"), join(root, "escape"));

// Records what the use cases ask of the machine; a start finishes when the test says so.
class FakeLauncher implements AgentLauncher {
  started: { agent: AgentSpec; all: FleetRow[] }[] = [];
  stopped: { name: string; remaining: FleetRow[] }[] = [];
  rewrites: FleetRow[][] = [];
  stopError: Error | null = null;
  open = new Set<string>();
  finish: ((e?: Error) => void) | null = null;
  async resolveDir(path: string) {
    const { realpath } = await import("node:fs/promises");
    const real = await realpath(path).catch(() => { throw new AgentError("invalid", "not a folder"); });
    const r = await realpath(root);
    if (!real.startsWith(r + "/")) throw new AgentError("invalid", `cwd must be a folder inside ${root}`);
    return real;
  }
  async folders() { return [join(root, "sandbox")]; }
  start(agent: AgentSpec, rows: () => FleetRow[]) {
    this.started.push({ agent, all: rows() });
    return new Promise<void>((resolve, reject) => { this.finish = (e) => { if (e) reject(e); else { this.open.add(agent.name); resolve(); } }; });
  }
  async stop(name: string, rows: () => FleetRow[]) { this.stopped.push({ name, remaining: rows().filter((r) => r.name !== name) }); if (this.stopError) throw this.stopError; this.open.delete(name); }
  async rewrite(rows: () => FleetRow[]) { this.rewrites.push(rows()); }
  async running() { return new Set(this.open); }
}

function setup() {
  const store = new Store(":memory:");
  const launcher = new FakeLauncher();
  const agents = new Agents(store.db);
  const auth = new Auth(parseTokens([tokenLine("op", "op-token-0000000000000000000000000000000000", "operator"), tokenLine("ag", "ag-token", "agent"), tokenLine("vw", "vw-token", "viewer")].join("\n")));
  const fleet = { screen: async () => "", status: async () => ({ sessions: [], raw: "" }) } as never;
  const server = serve({ fleet, store, agents: { agents, launcher, models: { claude: ["sonnet", "opus", "haiku"] } } }, 0, { auth });
  const call = (token: string, path: string, body?: unknown) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { server, launcher, agents, call };
}
const spec = (over: Record<string, unknown> = {}) => ({ name: "fc-one", cwd: join(root, "sandbox"), model: "haiku", prompt: "Say READY.", confirm: "fc-one", ...over });
const settle = () => new Promise((r) => setTimeout(r, 10));

test("an operator starts an agent; the reply comes before the launch ends and the row follows it", async () => {
  const { server, launcher, call } = setup();
  try {
    const res = await call("op-token-0000000000000000000000000000000000", "/api/agents", spec());
    expect(res.status).toBe(202);
    const { agent } = await res.json() as { agent: Record<string, unknown> };
    expect(agent).toMatchObject({ name: "fc-one", model: "haiku", state: "starting", createdBy: "op", promptBytes: 10 });
    expect(agent.promptSha256).toBe(new Bun.CryptoHasher("sha256").update("Say READY.").digest("hex"));
    expect(launcher.started).toHaveLength(1);
    expect(launcher.started[0]!.all).toEqual([{ name: "fc-one", kind: "claude", cwd: agent.cwd as string, model: "haiku" }]);
    launcher.finish!();
    await settle();
    const list = await (await call("vw-token", "/api/agents")).json() as { agents: { name: string; state: string; alive: boolean }[]; models: string[]; folders: string[] };
    expect(list.agents.map((a) => [a.name, a.state, a.alive])).toEqual([["fc-one", "running", true]]);
    expect(list.models).toEqual(["sonnet", "opus", "haiku"]);
    expect(list.folders).toEqual([join(root, "sandbox")]);

    const stop = await call("op-token-0000000000000000000000000000000000", "/api/agents/fc-one/stop", {});
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as { agent: { state: string } }).agent.state).toBe("stopped");
    expect(launcher.stopped).toEqual([{ name: "fc-one", remaining: [] }]);
  } finally { server.stop(true); }
});

test("an agent or viewer token may not start or stop agents", async () => {
  const { server, launcher, call } = setup();
  try {
    for (const token of ["ag-token", "vw-token"]) {
      const res = await call(token, "/api/agents", spec());
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/may not start or stop agents/);
      expect((await call(token, "/api/agents/fc-one/stop", {})).status).toBe(403);
    }
    expect(launcher.started).toEqual([]);
  } finally { server.stop(true); }
});

test("a start is refused without confirmation, outside the roots, with an unknown model, a bad name or a token in the prompt", async () => {
  const { server, launcher, call } = setup();
  const op = "op-token-0000000000000000000000000000000000";
  try {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ confirm: undefined }, /confirm must repeat/],
      [{ confirm: "fc-other" }, /confirm must repeat/],
      [{ cwd: join(dir, "elsewhere") }, /inside/],
      [{ cwd: join(root, "escape") }, /inside/],
      [{ cwd: join(root, "missing") }, /not a folder/],
      [{ model: "gpt" }, /model must be one of/],
      [{ name: "probe-shell", confirm: "probe-shell" }, /name must be fc-/],
      [{ prompt: "  " }, /prompt is required/],
      [{ prompt: `use ${op} please` }, /access token/],
    ];
    for (const [over, message] of cases) {
      const res = await call(op, "/api/agents", spec(over));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(message);
    }
    expect(launcher.started).toEqual([]);
  } finally { server.stop(true); }
});

test("a second start of the same name is a conflict until the first is stopped, and a failed launch is recorded", async () => {
  const { server, launcher, call } = setup();
  const op = "op-token-0000000000000000000000000000000000";
  try {
    expect((await call(op, "/api/agents", spec())).status).toBe(202);
    const again = await call(op, "/api/agents", spec());
    expect(again.status).toBe(409);
    launcher.finish!(new AgentError("unavailable", "fleet start exited 1: claude UI not detected after 90 s"));
    await settle();
    const list = await (await call(op, "/api/agents")).json() as { agents: { state: string; error: string; alive: boolean }[] };
    expect(list.agents[0]).toMatchObject({ state: "failed", alive: false, error: "fleet start exited 1: claude UI not detected after 90 s" });
    // A failed row may be started again.
    expect((await call(op, "/api/agents", spec({ model: "sonnet" }))).status).toBe(202);
    expect(launcher.started.map((s) => s.agent.model)).toEqual(["haiku", "sonnet"]);
    // Stopping an unknown or already stopped agent is refused.
    expect((await call(op, "/api/agents/fc-none/stop", {})).status).toBe(404);
  } finally { server.stop(true); }
});

test("a browser start from another origin is refused", async () => {
  const { server, launcher } = setup();
  try {
    const res = await fetch(new URL("/api/agents", server.url), {
      method: "POST", body: JSON.stringify(spec()),
      headers: { authorization: "Bearer op-token-0000000000000000000000000000000000", "content-type": "application/json", origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(launcher.started).toEqual([]);
  } finally { server.stop(true); }
});

const opCaller = { name: "op", role: "operator" as const };
const row = (name: string, state: "starting" | "running" | "failed" | "stopping" | "stopped") => ({
  name, kind: "claude" as const, cwd: join(root, "sandbox"), model: "haiku", promptSha256: "0".repeat(64), promptBytes: 1,
  createdBy: "op", createdAt: "2026-11-19T00:00:00.000Z", state, error: null, updatedAt: "2026-11-19T00:00:00.000Z",
});

test("after a restart, starting and stopping rows are settled by whether their session is open, and fleet rows are rewritten", async () => {
  const store = new Store(":memory:");
  const agents = new Agents(store.db);
  const launcher = new FakeLauncher();
  for (const [name, state] of [["fc-a", "starting"], ["fc-b", "starting"], ["fc-c", "stopping"], ["fc-d", "stopping"], ["fc-e", "running"], ["fc-f", "failed"]] as const) {
    agents.claim({ ...row(name, "starting"), state } as never);
  }
  launcher.open = new Set(["fc-a", "fc-c", "fc-e"]);
  const uc = agentUseCases({ agents, launcher, models: { claude: ["haiku"] } });
  expect((await uc.recover()).sort()).toEqual(["fc-a", "fc-b", "fc-c", "fc-d"]);
  const by = Object.fromEntries(agents.list().map((a) => [a.name, a]));
  expect(by["fc-a"]).toMatchObject({ state: "running", error: null });
  expect(by["fc-b"]).toMatchObject({ state: "failed", error: "start interrupted by a service restart" });
  expect(by["fc-c"]).toMatchObject({ state: "failed", error: "stop interrupted by a service restart; stop it again" });
  expect(by["fc-d"]).toMatchObject({ state: "stopped" });
  expect(by["fc-e"]?.state).toBe("running");
  expect(by["fc-f"]?.state).toBe("failed");
  // Only live rows keep a fleet entry, so the watchdog does not recreate failed agents.
  expect(launcher.rewrites.at(-1)!.map((r) => r.name)).toEqual(["fc-a", "fc-e"]);
});

test("a row left stopping can be stopped again", async () => {
  const store = new Store(":memory:");
  const agents = new Agents(store.db);
  const launcher = new FakeLauncher();
  agents.claim({ ...row("fc-s", "starting"), state: "stopping" } as never);
  const uc = agentUseCases({ agents, launcher, models: { claude: ["haiku"] } }, opCaller);
  expect((await uc.stop("fc-s")).state).toBe("stopped");
  expect(launcher.stopped.map((s) => s.name)).toEqual(["fc-s"]);
});

test("a failed start or stop takes the agent out of the fleet rows", async () => {
  const store = new Store(":memory:");
  const agents = new Agents(store.db);
  const launcher = new FakeLauncher();
  agents.claim({ ...row("fc-keep", "starting"), state: "running" } as never);
  const uc = agentUseCases({ agents, launcher, models: { claude: ["haiku"] } }, opCaller);
  const { launched } = await uc.start(spec({ name: "fc-bad", confirm: "fc-bad" }));
  expect(launcher.started[0]!.all.map((r) => r.name)).toEqual(["fc-keep", "fc-bad"]);
  launcher.finish!(new Error("fleet start exited 1"));
  await launched;
  expect(agents.get("fc-bad")!.state).toBe("failed");
  expect(launcher.rewrites.at(-1)!.map((r) => r.name)).toEqual(["fc-keep"]);
  launcher.stopError = new Error("tmux kill-session exited 1");
  await expect(uc.stop("fc-keep")).rejects.toThrow("tmux kill-session exited 1");
  expect(agents.get("fc-keep")!.state).toBe("failed");
  expect(launcher.rewrites.at(-1)!.map((r) => r.name)).toEqual([]);
});

test("an agent stopped while it was still starting is stopped again once its launch ends", async () => {
  const store = new Store(":memory:");
  const agents = new Agents(store.db);
  const launcher = new FakeLauncher();
  const uc = agentUseCases({ agents, launcher, models: { claude: ["haiku"] } }, opCaller);
  const { launched } = await uc.start(spec());
  expect((await uc.stop("fc-one")).state).toBe("stopped");
  // The launch completes after the stop: its session must not be left running.
  launcher.finish!();
  await launched;
  expect(agents.get("fc-one")!.state).toBe("stopped");
  expect(launcher.stopped.map((s) => s.name)).toEqual(["fc-one", "fc-one"]);
  expect(launcher.open.has("fc-one")).toBe(false);
});

test("serve refuses managed agents without tokens", () => {
  const store = new Store(":memory:");
  const fleet = { screen: async () => "", status: async () => ({ sessions: [], raw: "" }) } as never;
  expect(() => serve({ fleet, store, agents: { agents: new Agents(store.db), launcher: new FakeLauncher(), models: { claude: ["haiku"] } } }, 0, {}))
    .toThrow("managed agents need tokens");
});

test("rows are read when the file is written, so a stop is not undone by a start that waited", async () => {
  const store = new Store(":memory:");
  const agents = new Agents(store.db);
  // Writes happen in call order but only when the test releases them, like the launcher's queue.
  const writes: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let queue: Promise<unknown> = gate;
  const write = (rows: () => FleetRow[]) => { const next = queue.then(() => { writes.push(rows().map((r) => r.name)); }); queue = next; return next; };
  const launcher: AgentLauncher = {
    resolveDir: async (p) => p, folders: async () => [], running: async () => new Set(),
    start: (_a, rows) => write(rows), stop: (_n, rows) => write(rows), rewrite: (rows) => write(rows),
  };
  for (const name of ["fc-a", "fc-c"]) agents.claim({ ...row(name, "starting"), state: "running" } as never);
  const uc = agentUseCases({ agents, launcher, models: { claude: ["haiku"] } }, opCaller);
  // The start is queued first, while fc-a and fc-c still run; both are stopped before its write runs.
  const { launched } = await uc.start(spec({ name: "fc-b", confirm: "fc-b", cwd: root }));
  const stopA = uc.stop("fc-a");
  const stopC = uc.stop("fc-c");
  release();
  await Promise.all([stopA, stopC, launched]);
  expect(agents.get("fc-a")!.state).toBe("stopped");
  // Every write saw the store as it was then; the last one holds only the agent still running.
  expect(writes.at(-1)).toEqual(["fc-b"]);
  expect(writes.every((w) => !w.includes("fc-a") && !w.includes("fc-c"))).toBe(true);
});

test("a late failure of an earlier start does not touch a newer start of the same name", async () => {
  const store = new Store(":memory:");
  const agents = new Agents(store.db);
  const launcher = new FakeLauncher();
  let clock = 0;
  const uc = agentUseCases({ agents, launcher, models: { claude: ["haiku"] }, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)) }, opCaller);
  const first = await uc.start(spec());
  const finishFirst = launcher.finish!;
  // Stopped while starting, then started again before the first launch gave up.
  expect((await uc.stop("fc-one")).state).toBe("stopped");
  const second = await uc.start(spec());
  finishFirst(new Error("claude UI not detected after 90 s"));
  await first.launched;
  expect(agents.get("fc-one")).toMatchObject({ state: "starting", createdAt: second.agent.createdAt });
  launcher.finish!();
  await second.launched;
  expect(agents.get("fc-one")!.state).toBe("running");
});

test("a failed rewrite after a failed start is reported, not swallowed", async () => {
  const store = new Store(":memory:");
  const agents = new Agents(store.db);
  const launcher = new FakeLauncher();
  launcher.rewrite = async () => { throw new Error("disk full"); };
  const warned: string[] = [];
  const uc = agentUseCases({ agents, launcher, models: { claude: ["haiku"] }, warn: (m) => warned.push(m) }, opCaller);
  const { launched } = await uc.start(spec());
  launcher.finish!(new Error("fleet start exited 1"));
  await launched;
  expect(warned).toEqual(["agent fc-one: fleet rows not rewritten after a failed start: disk full"]);
});

test("a start that finishes after its stop failed ends the session it made", async () => {
  const store = new Store(":memory:");
  const agents = new Agents(store.db);
  const launcher = new FakeLauncher();
  const uc = agentUseCases({ agents, launcher, models: { claude: ["haiku"] }, warn: () => undefined }, opCaller);
  const { launched } = await uc.start(spec());
  launcher.stopError = new Error("tmux kill-session exited 1");
  await expect(uc.stop("fc-one")).rejects.toThrow("tmux kill-session exited 1");
  expect(agents.get("fc-one")!.state).toBe("failed");
  launcher.stopError = null;
  launcher.finish!();
  await launched;
  expect(launcher.stopped.map((s) => s.name)).toEqual(["fc-one", "fc-one"]);
  expect(launcher.open.has("fc-one")).toBe(false);
});

test("a DSH agent is started with a model from the DSH list; a host without DSH models refuses kind dsh", async () => {
  const store = new Store(":memory:");
  const launcher = new FakeLauncher();
  const models = { claude: ["haiku"], dsh: ["deepseek-official/deepseek-flash"] };
  const uc = agentUseCases({ agents: new Agents(store.db), launcher, models }, { name: "op", role: "operator" });
  const deep = { name: "fc-deep", kind: "dsh", cwd: join(root, "sandbox"), model: "deepseek-official/deepseek-flash", prompt: "Say READY.", confirm: "fc-deep" };
  // A Claude model for a DSH agent, and a DSH model for a Claude agent, are both refused.
  await expect(uc.start({ ...deep, model: "haiku" })).rejects.toThrow("model must be one of deepseek-official/deepseek-flash");
  await expect(uc.start({ ...deep, kind: "claude" })).rejects.toThrow("model must be one of haiku");
  await expect(uc.start({ ...deep, kind: "codex" })).rejects.toThrow("kind must be one of claude, dsh");
  const { agent, launched } = await uc.start(deep);
  expect(agent.kind).toBe("dsh");
  expect(launcher.started[0]!.agent.kind).toBe("dsh");
  expect(launcher.started[0]!.all).toEqual([{ name: "fc-deep", kind: "dsh", cwd: agent.cwd, model: "deepseek-official/deepseek-flash" }]);
  launcher.finish!();
  await launched;
  expect((await uc.list())[0]).toMatchObject({ name: "fc-deep", kind: "dsh", state: "running", alive: true });
  // A start without a kind is a Claude Code start, as before DSH agents.
  const plain = await uc.start({ name: "fc-plain", cwd: join(root, "sandbox"), model: "haiku", prompt: "x", confirm: "fc-plain" });
  expect(plain.agent.kind).toBe("claude");

  const claudeOnly = agentUseCases({ agents: new Agents(new Store(":memory:").db), launcher: new FakeLauncher(), models: { claude: ["haiku"] } }, { name: "op", role: "operator" });
  await expect(claudeOnly.start({ ...deep, name: "fc-d2", confirm: "fc-d2" })).rejects.toThrow("kind must be one of claude");
});

test("a table made before DSH agents gains a kind column and its rows read as claude", () => {
  const store = new Store(":memory:");
  store.db.run(`CREATE TABLE agents (name TEXT PRIMARY KEY, cwd TEXT NOT NULL, model TEXT NOT NULL, prompt_sha256 TEXT NOT NULL,
    prompt_bytes INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'failed', 'stopping', 'stopped')), error TEXT, updated_at TEXT NOT NULL)`);
  store.db.run(`INSERT INTO agents VALUES ('fc-old', '/r/a', 'haiku', '0', 1, 'op', 't0', 'stopped', NULL, 't0')`);
  const agents = new Agents(store.db);
  expect(agents.get("fc-old")!.kind).toBe("claude");
  expect(() => store.db.run("UPDATE agents SET kind = 'codex'")).toThrow();
});
