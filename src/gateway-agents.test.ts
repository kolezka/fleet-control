// The MacBook gateway relays the managed-agent routes to a real host service and nothing more.
import { afterAll, expect, test } from "bun:test";
import { Auth, parseTokens, tokenLine } from "./auth.ts";
import { Credentials, startGateway } from "./client-gateway.ts";
import { Agents } from "./data/agents.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";
import type { AgentLauncher, AgentSpec, FleetRow } from "./domain/agents.ts";

const calls: string[] = [];
const launcher: AgentLauncher = {
  resolveDir: async (p) => p,
  folders: async () => ["/r/sandbox"],
  start: async (a: AgentSpec, rows: () => FleetRow[]) => { calls.push(`start ${a.name} ${a.cwd} ${a.model} ${rows().length}`); },
  stop: async (name: string) => { calls.push(`stop ${name}`); },
  rewrite: async () => undefined,
  running: async () => new Set(calls.filter((c) => c.startsWith("start")).length > calls.filter((c) => c.startsWith("stop")).length ? ["fc-gw"] : []),
};
const store = new Store(":memory:");
const host = serve({ fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => "" }, store, agents: { agents: new Agents(store.db), launcher, models: ["haiku"] } },
  0, { auth: new Auth(parseTokens(tokenLine("gw", "gateway-token", "operator"))) });
const gateway = startGateway({ hosts: [{ id: "mini", name: "mini", origin: host.url.origin }], credentials: new Credentials(new Map([["mini", "gateway-token"]])) }, { port: 0, timeoutMs: 2000 });
afterAll(() => { gateway.stop(true); host.stop(true); store.db.close(); });
const url = (path: string) => `${gateway.url}api/hosts/mini/${path}`;
const post = (path: string, body: unknown, origin: string | null = gateway.url.origin) => fetch(url(path), {
  method: "POST", headers: { ...(origin ? { origin } : {}), "content-type": "application/json" }, body: JSON.stringify(body),
});

test("start, list and stop go through the gateway with the host's checks intact", async () => {
  const listed = await (await fetch(url("agents"))).json() as { models: string[]; folders: string[]; agents: unknown[] };
  expect(listed).toEqual({ agents: [], models: ["haiku"], folders: ["/r/sandbox"] });

  // The host's own validation answers through the gateway.
  const bad = await post("agents", { name: "fc-gw", cwd: "/r/sandbox", model: "haiku", prompt: "hi", confirm: "nope" });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: { message: string } }).error.message).toMatch(/confirm must repeat/);

  const started = await post("agents", { name: "fc-gw", cwd: "/r/sandbox", model: "haiku", prompt: "hi", confirm: "fc-gw" });
  expect(started.status).toBe(202);
  expect(((await started.json()) as { agent: { state: string; createdBy: string } }).agent).toMatchObject({ state: "starting", createdBy: "gw" });
  await Bun.sleep(10);
  const after = await (await fetch(url("agents"))).json() as { agents: { name: string; state: string; alive: boolean }[] };
  expect(after.agents.map((a) => [a.name, a.state, a.alive])).toEqual([["fc-gw", "running", true]]);

  const stopped = await post("agents/fc-gw/stop", {});
  expect(stopped.status).toBe(200);
  expect(calls).toEqual(["start fc-gw /r/sandbox haiku 1", "stop fc-gw"]);
});

test("the gateway refuses agent writes without Origin and anything outside the allowlist", async () => {
  expect((await post("agents", { name: "fc-x" }, null)).status).toBe(403);
  expect((await post("agents/fc-gw/stop", {}, "https://evil.example")).status).toBe(403);
  expect((await post("agents/fc-gw/restart", {})).status).toBe(404);
  expect((await fetch(url("agents/fc-gw/stop"))).status).toBe(405);
  expect(calls.filter((c) => c.includes("fc-x"))).toEqual([]);
});
