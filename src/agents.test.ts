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
  start(agent: AgentSpec, all: FleetRow[]) {
    this.started.push({ agent, all });
    return new Promise<void>((resolve, reject) => { this.finish = (e) => { if (e) reject(e); else { this.open.add(agent.name); resolve(); } }; });
  }
  async stop(name: string, remaining: FleetRow[]) { this.stopped.push({ name, remaining }); this.open.delete(name); }
  async running() { return new Set(this.open); }
}

function setup() {
  const store = new Store(":memory:");
  const launcher = new FakeLauncher();
  const agents = new Agents(store.db);
  const auth = new Auth(parseTokens([tokenLine("op", "op-token-0000000000000000000000000000000000", "operator"), tokenLine("ag", "ag-token", "agent"), tokenLine("vw", "vw-token", "viewer")].join("\n")));
  const fleet = { screen: async () => "", status: async () => ({ sessions: [], raw: "" }) } as never;
  const server = serve({ fleet, store, agents: { agents, launcher, models: ["sonnet", "opus", "haiku"] } }, 0, { auth });
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
    expect(launcher.started[0]!.all).toEqual([{ name: "fc-one", cwd: agent.cwd as string, model: "haiku" }]);
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
