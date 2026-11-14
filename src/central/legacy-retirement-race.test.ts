import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import type { CentralCommandStore } from "./application/commands.ts";
import type { CentralRequests } from "./data/requests.ts";
import { createCentralApp } from "./server.ts";

test("legacy supervisor mutations check identity after authentication and before writing", async () => {
  const principal = { name: "supervisor", role: "supervisor" as const, principalId: "supervisor-id", hostId: "host", session: "session" };
  const auth = new CentralAuth([{ tokenHash: createHash("sha256").update("test-token").digest("hex"), principal }]);
  let active = true;
  const checks: boolean[] = [];
  const locks: boolean[] = [];
  const writes: unknown[] = [];
  const tx = {} as never;
  const identities = {
    async matches() { checks.push(active); return active; },
    async lockActive(received: unknown, identity: unknown) {
      expect(received).toBe(tx);
      expect(identity).toEqual({ name: principal.name, principalId: principal.principalId, hostId: principal.hostId, session: principal.session });
      locks.push(active);
      return active;
    },
  };
  const requests = {
    async registerRun(input: { runId: string; phase: string; orchestrator: string }, guard: (tx: never) => Promise<void>) {
      await guard(tx);
      writes.push({ active, ...input });
      return { id: input.runId, phase: input.phase, orchestrator: input.orchestrator };
    },
  } as unknown as CentralRequests;
  const commands = {} as CentralCommandStore;
  const app = createCentralApp({ auth, identities, commands, requests });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_register", arguments: { runId: "run-1", phase: "plan" } } });
  const headers = { authorization: "Bearer test-token", "content-type": "application/json", accept: "application/json, text/event-stream" };
  let bodyRead!: () => void;
  let releaseBody!: () => void;
  const reading = new Promise<void>((resolve) => { bodyRead = resolve; });
  const released = new Promise<void>((resolve) => { releaseBody = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      bodyRead();
      await released;
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const pending = app.request("/mcp", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
  await reading;
  expect(checks).toEqual([true]);
  expect(writes).toEqual([]);
  active = false;
  releaseBody();
  const response = await pending;
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.result.isError).toBe(true);
  expect(locks).toEqual([false]);
  expect(writes).toEqual([]);
  const later = await app.request("/mcp", { method: "POST", headers, body });
  expect(later.status).toBe(401);
  expect(checks).toEqual([true, false]);

  active = true;
  const positive = await app.request("/mcp", { method: "POST", headers, body });
  expect(positive.status).toBe(200);
  const positiveResult = await positive.json();
  expect(positiveResult.result.isError).not.toBe(true);
  expect(JSON.parse(positiveResult.result.content[0].text).run.id).toBe("run-1");
  expect(locks).toEqual([false, true]);
  const lookupOnlyApp = createCentralApp({ auth, identities: { matches: identities.matches }, commands, requests });
  const lookupOnlyResponse = await lookupOnlyApp.request("/mcp", { method: "POST", headers, body });
  expect((await lookupOnlyResponse.json()).result.isError).toBe(true);
  expect(locks).toEqual([false, true]);
  expect(writes).toEqual([{ active: true, runId: "run-1", phase: "plan", orchestrator: `central-supervisor
${JSON.stringify(["supervisor", "supervisor-id", "host", "session"])}` }]);
});
