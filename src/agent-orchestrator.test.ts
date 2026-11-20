// An orchestrator agent gets its own agent-role token in the host's tokens file and this host's MCP.
// It can register a run and ask for approval, never answer; only the operator approves; a stop revokes it.
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAgentTokens } from "./agent-tokens.ts";
import { agentUseCases } from "./application/agents.ts";
import { Auth, newToken, tokenLine } from "./auth.ts";
import { Agents } from "./data/agents.ts";
import { Commands } from "./data/commands.ts";
import { Requests } from "./data/requests.ts";
import { Store } from "./data/store.ts";
import type { AgentLauncher, AgentSpec, FleetRow } from "./domain/agents.ts";
import { serve } from "./server.ts";

const dir = await mkdtemp(join(tmpdir(), "fc-orch-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const root = join(dir, "fleet-agents");
await mkdir(join(root, "work"), { recursive: true });

// Keeps the token the launcher was given, as the MCP config file would.
class Launcher implements AgentLauncher {
  given = new Map<string, string | undefined>();
  open = new Set<string>();
  async resolveDir(p: string) { return (await import("node:fs/promises")).realpath(p); }
  async folders() { return [join(root, "work")]; }
  async start(agent: AgentSpec, _rows: () => FleetRow[], mcpToken?: string) { this.given.set(agent.name, mcpToken); this.open.add(agent.name); }
  async stop(name: string) { this.open.delete(name); }
  async rewrite() {}
  async running() { return new Set(this.open); }
}

async function setup() {
  const tokensFile = join(dir, `tokens-${crypto.randomUUID()}`);
  const op = newToken();
  await writeFile(tokensFile, `${tokenLine("op", op, "operator")}\n`, { mode: 0o600 });
  const auth = await Auth.fromFile(tokensFile);
  const store = new Store(":memory:");
  const launcher = new Launcher();
  const tokens = new FileAgentTokens(tokensFile, auth);
  const agents = new Agents(store.db);
  const server = serve({
    fleet: { screen: async () => "", status: async () => ({ sessions: [], raw: "" }) } as never, store,
    control: { commands: new Commands(store.db), deliverer: { deliver: async () => undefined } as never, requests: new Requests(store.db) },
    agents: { agents, launcher, models: { claude: ["haiku"] }, tokens },
  }, 0, { auth });
  const rest = (token: string, path: string, body?: unknown) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, origin: server.url.origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let id = 0;
  const mcp = async (token: string, name: string, args: object) => {
    const r = await fetch(new URL("/mcp", server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    return { status: r.status, body: await r.json() as { result?: { isError?: boolean; content: { text: string }[] } } };
  };
  return { server, launcher, op, tokensFile, rest, mcp, agents, auth, tokens };
}
const spec = (over: Record<string, unknown> = {}) => ({ name: "fc-orch", cwd: join(root, "work"), model: "haiku", prompt: "Run the phases.", confirm: "fc-orch", orchestrator: true, ...over });
const settle = () => new Promise((r) => setTimeout(r, 20));

test("an orchestrator's token registers a run and asks; only the operator answers; the stop revokes the token", async () => {
  const s = await setup();
  try {
    const list = await (await s.rest(s.op, "/api/agents")).json() as { orchestrators: boolean };
    expect(list.orchestrators).toBe(true);
    expect((await s.rest(s.op, "/api/agents", spec())).status).toBe(202);
    await settle();
    const token = s.launcher.given.get("fc-orch")!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the hash is in the file, under the agent's name, with the agent role.
    const file = await readFile(s.tokensFile, "utf8");
    expect(file).not.toContain(token);
    expect(file).toMatch(/^fc-orch [0-9a-f]{64} agent$/m);
    expect((await stat(s.tokensFile)).mode & 0o777).toBe(0o600);
    expect(s.agents.get("fc-orch")).toMatchObject({ state: "running", orchestrator: true });

    // The run and the request carry the agent's name, whatever it declares.
    const reg = await s.mcp(token, "run_register", { runId: "run-1", orchestrator: "someone-else", phase: "phase-1" });
    expect(reg.body.result?.isError).toBeFalsy();
    expect(JSON.parse(reg.body.result!.content[0]!.text).run.orchestrator).toBe("fc-orch");
    const ask = await s.mcp(token, "request_create", { runId: "run-1", origin: "x", expectedRevision: 1, kind: "approval", question: "Phase 1 done. Go on?" });
    const request = JSON.parse(ask.body.result!.content[0]!.text).request as { id: string; origin: string; revision: number };
    expect(request.origin).toBe("fc-orch");
    // It cannot approve its own request.
    const self = await s.mcp(token, "request_resolve", { requestId: request.id, response: "approve", actor: "op", expectedRevision: 1 });
    expect(self.body.result?.isError).toBe(true);
    expect(self.body.result!.content[0]!.text).toContain("role agent may not answer requests");
    // The operator approves from the page; the agent reads it and acknowledges.
    const approved = await s.rest(s.op, `/api/requests/${request.id}/resolve`, { response: "approve", expectedRevision: 1 });
    expect(approved.status).toBe(200);
    const gate = await s.mcp(token, "request_gate", { runId: "run-1", phase: "phase-1", revision: 1 });
    expect(gate.body.result!.content[0]!.text).toContain("approve");
    const ack = await s.mcp(token, "request_acknowledge", { requestId: request.id, actor: "x" });
    expect(ack.body.result?.isError).toBeFalsy();

    // Stop: the token is gone from the file and from the running service at once.
    expect((await s.rest(s.op, "/api/agents/fc-orch/stop", {})).status).toBe(200);
    expect(await readFile(s.tokensFile, "utf8")).not.toContain("fc-orch");
    expect((await s.mcp(token, "run_list", {})).status).toBe(401);
    expect(s.auth.names()).toEqual(["op"]);
  } finally {
    s.server.stop(true);
  }
});

test("a plain agent gets no token; a failed start, a restart and a second start never leave an old token working", async () => {
  const s = await setup();
  try {
    expect((await s.rest(s.op, "/api/agents", spec({ name: "fc-plain", confirm: "fc-plain", orchestrator: false }))).status).toBe(202);
    await settle();
    expect(s.launcher.given.get("fc-plain")).toBeUndefined();
    expect(await readFile(s.tokensFile, "utf8")).not.toContain("fc-plain");

    // A launch that fails takes its token with it.
    const start = s.launcher.start.bind(s.launcher);
    s.launcher.start = async (a, r, t) => { s.launcher.given.set(a.name, t); throw new Error("claude UI not detected"); };
    expect((await s.rest(s.op, "/api/agents", spec())).status).toBe(202);
    await settle();
    const failed = s.launcher.given.get("fc-orch")!;
    expect(s.agents.get("fc-orch")!.state).toBe("failed");
    expect(await readFile(s.tokensFile, "utf8")).not.toContain("fc-orch");
    expect((await s.mcp(failed, "run_list", {})).status).toBe(401);
    s.launcher.start = start;

    // A line left behind (a crash after issue) is revoked when the service settles rows at start.
    const leftover = newToken();
    await writeFile(s.tokensFile, `${await readFile(s.tokensFile, "utf8")}${tokenLine("fc-orch", leftover, "agent")}\n`);
    s.auth.replace(await Auth.fromFile(s.tokensFile));
    expect((await s.mcp(leftover, "run_list", {})).status).toBe(200);
    await agentUseCases({ agents: s.agents, launcher: s.launcher, models: { claude: ["haiku"] }, tokens: s.tokens }).recover();
    expect((await s.mcp(leftover, "run_list", {})).status).toBe(401);

    // A new start under the same name replaces any line, so only the newest token works.
    await writeFile(s.tokensFile, `${await readFile(s.tokensFile, "utf8")}${tokenLine("fc-orch", leftover, "agent")}\n`);
    s.auth.replace(await Auth.fromFile(s.tokensFile));
    expect((await s.rest(s.op, "/api/agents", spec())).status).toBe(202);
    await settle();
    const fresh = s.launcher.given.get("fc-orch")!;
    expect(fresh).not.toBe(leftover);
    expect((await s.mcp(leftover, "run_list", {})).status).toBe(401);
    expect((await s.mcp(fresh, "run_list", {})).status).toBe(200);
    expect((await readFile(s.tokensFile, "utf8")).match(/^fc-orch /gm)).toHaveLength(1);
  } finally {
    s.server.stop(true);
  }
});

test("orchestrators are refused where the host has no token store, and for DSH agents", async () => {
  const s = await setup();
  try {
    const plain = serve({ fleet: { screen: async () => "", status: async () => ({ sessions: [], raw: "" }) } as never, store: new Store(":memory:"),
      agents: { agents: new Agents(new Store(":memory:").db), launcher: s.launcher, models: { claude: ["haiku"], dsh: ["deepseek-official/deepseek-flash"] } } }, 0, { auth: s.auth });
    try {
      const call = (body?: unknown) => fetch(new URL("/api/agents", plain.url), { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${s.op}`, origin: plain.url.origin, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(((await (await call()).json()) as { orchestrators: boolean }).orchestrators).toBe(false);
      const r = await call(spec());
      expect(r.status).toBe(503);
      expect(((await r.json()) as { error: { message: string } }).error.message).toBe("orchestrators are not set up on this host");
    } finally { plain.stop(true); }
    const dsh = await s.rest(s.op, "/api/agents", spec({ kind: "dsh", model: "deepseek-official/deepseek-flash" }));
    expect(dsh.status).toBe(400);
    const bad = await s.rest(s.op, "/api/agents", spec({ orchestrator: "yes" }));
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe("orchestrator must be true or false");
  } finally {
    s.server.stop(true);
  }
});

test("a hand-made token under an agent's name is never replaced or removed, and the start that would is refused", async () => {
  const s = await setup();
  try {
    const mine = newToken();
    await writeFile(s.tokensFile, `${await readFile(s.tokensFile, "utf8")}${tokenLine("fc-orch", mine, "operator")}\n`);
    s.auth.replace(await Auth.fromFile(s.tokensFile));
    const before = await readFile(s.tokensFile, "utf8");
    expect((await s.rest(s.op, "/api/agents", spec())).status).toBe(202);
    await settle();
    expect(s.agents.get("fc-orch")).toMatchObject({ state: "failed" });
    expect(s.agents.get("fc-orch")!.error).toContain("fc-orch is a token for role operator, not a managed agent");
    expect(s.launcher.given.has("fc-orch")).toBe(false);
    // Neither the failed start nor a service start nor a direct revoke touches the line.
    await agentUseCases({ agents: s.agents, launcher: s.launcher, models: { claude: ["haiku"] }, tokens: s.tokens }).recover();
    await s.tokens.revoke("fc-orch");
    expect(await readFile(s.tokensFile, "utf8")).toBe(before);
    expect((await s.rest(mine, "/api/whoami")).status).toBe(200);
  } finally {
    s.server.stop(true);
  }
});

test("a stop whose token cannot be revoked still ends the session and says the token is left", async () => {
  const s = await setup();
  try {
    expect((await s.rest(s.op, "/api/agents", spec())).status).toBe(202);
    await settle();
    expect(s.launcher.open.has("fc-orch")).toBe(true);
    const revoke = s.tokens.revoke.bind(s.tokens);
    s.tokens.revoke = async () => { throw new Error("tokens file is locked"); };
    const r = await s.rest(s.op, "/api/agents/fc-orch/stop", {});
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(s.launcher.open.has("fc-orch")).toBe(false);
    expect(s.agents.get("fc-orch")!.state).toBe("failed");
    expect(s.agents.get("fc-orch")!.error).toContain("token was not revoked (tokens file is locked); stop again to retry");
    // A second stop takes the token back.
    s.tokens.revoke = revoke;
    expect((await s.rest(s.op, "/api/agents/fc-orch/stop", {})).status).toBe(200);
    expect(await readFile(s.tokensFile, "utf8")).not.toContain("fc-orch");
  } finally {
    s.server.stop(true);
  }
});

test("a failed start whose token cannot be revoked shows that on the row", async () => {
  const s = await setup();
  try {
    s.launcher.start = async () => { throw new Error("claude UI not detected"); };
    s.tokens.revoke = async () => { throw new Error("tokens file is locked"); };
    expect((await s.rest(s.op, "/api/agents", spec())).status).toBe(202);
    await settle();
    expect(s.agents.get("fc-orch")).toMatchObject({ state: "failed" });
    expect(s.agents.get("fc-orch")!.error).toContain("claude UI not detected; token not revoked: tokens file is locked");
  } finally {
    s.server.stop(true);
  }
});
