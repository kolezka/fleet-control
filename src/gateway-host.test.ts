import { afterAll, expect, test } from "bun:test";
import { Auth, parseTokens, tokenLine } from "./auth.ts";
import { Credentials, startGateway } from "./client-gateway.ts";
import { Commands } from "./data/commands.ts";
import { Deliverer } from "./application/delivery.ts";
import { Requests } from "./data/requests.ts";
import { serve } from "./server.ts";
import { Store } from "./data/store.ts";

// Exercise the actual host authentication and persistence contract, not a proxy-shaped stub.
const stores: Store[] = [];
const services: ReturnType<typeof serve>[] = [];
const configs = ["alpha", "beta"].map((id) => {
  const store = new Store(":memory:");
  stores.push(store);
  const commands = new Commands(store.db);
  const requests = new Requests(store.db);
  requests.registerRun({ runId: "same-run", orchestrator: "supervisor", phase: "phase-1" });
  const request = requests.create({ runId: "same-run", origin: "supervisor", expectedRevision: 1, kind: "approval", question: `Approve ${id}?` });
  const token = `test-token-for-${id}`;
  const service = serve({
    fleet: { status: async () => ({ sessions: [], raw: "" }), screen: async () => id }, store,
    control: { commands, requests, deliverer: new Deliverer(commands, async () => ({ exitCode: 0, stdout: "supervisor: delivered", stderr: "" })) },
  }, 0, { auth: new Auth(parseTokens(tokenLine(`${id}-client`, token, "operator"))) });
  services.push(service);
  return { id, name: id, origin: service.url.origin, token, commands, requests, request };
});
const gateway = startGateway({ hosts: configs, credentials: new Credentials(new Map(configs.map((h) => [h.id, h.token]))) }, { port: 0, timeoutMs: 200 });
afterAll(() => {
  gateway.stop(true);
  for (const s of services) s.stop(true);
  for (const s of stores) s.db.close();
});
const post = (host: string, path: string, body: unknown) => fetch(`${gateway.url}api/hosts/${host}/${path}`, {
  method: "POST", headers: { origin: gateway.url.origin, "content-type": "application/json" }, body: JSON.stringify(body),
});

test("real hosts keep equal command keys and run names separate and derive their own principal", async () => {
  for (const host of configs) {
    const r = await post(host.id, "commands", { idempotencyKey: "same-key", target: "supervisor", actor: "spoofed", text: `Only ${host.id}` });
    expect(r.status).toBe(201);
    expect(host.commands.list()).toHaveLength(1);
    expect(host.commands.list()[0]!.actor).toBe(`${host.id}-client`);
    expect(host.commands.list()[0]!.text).toBe(`Only ${host.id}`);
  }
  expect(configs[0]!.commands.list()[0]!.id).not.toBe(configs[1]!.commands.list()[0]!.id);
});

test("an answer opens only the selected real host gate and stale revisions still conflict", async () => {
  const [alpha, beta] = configs;
  const answer = await post(alpha!.id, `requests/${alpha!.request.id}/resolve`, { response: "approve", expectedRevision: 1 });
  expect(answer.status).toBe(200);
  expect(alpha!.requests.gate("same-run", "phase-1", 1).approved).toBe(true);
  expect(beta!.requests.gate("same-run", "phase-1", 1).approved).toBe(false);
  expect(alpha!.requests.get(alpha!.request.id).resolvedBy).toBe("alpha-client");
  beta!.requests.updatePhase({ runId: "same-run", actor: "supervisor", expectedRevision: 1, phaseStatus: "changed", newRevision: true });
  expect((await post(beta!.id, `requests/${beta!.request.id}/resolve`, { response: "approve", expectedRevision: 1 })).status).toBe(409);
});

test("losing one actual host does not prevent reading another or approve its gate", async () => {
  services[0]!.stop(true);
  expect((await fetch(`${gateway.url}api/hosts/alpha/requests`)).status).toBe(502);
  const healthy = await fetch(`${gateway.url}api/hosts/beta/requests`);
  expect(healthy.status).toBe(200);
  expect((await healthy.json() as { runs: unknown[] }).runs).toHaveLength(1);
  expect(configs[1]!.requests.gate("same-run", "phase-1", 2).approved).toBe(false);
});
