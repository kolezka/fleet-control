import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";
import type { CooperativeClaims } from "./data/cooperative-claims.ts";
import type { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";

const supervisors = [
  { role: "supervisor" as const, principalId: "principal-a", name: "supervisor-a", hostId: "host-a", session: "session-a" },
  { role: "supervisor" as const, principalId: "principal-b", name: "supervisor-b", hostId: "host-b", session: "session-b" },
];
const credentials = [
  { incarnationId: "11111111-1111-4111-8111-111111111111", token: "a".repeat(43) },
  { incarnationId: "22222222-2222-4222-8222-222222222222", token: "b".repeat(43) },
];
const bearer = ["bearer-secret-a", "bearer-secret-b"];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("aborting a gated claim does not mix another supervisor's request", async () => {
  const entered = deferred();
  const release = deferred();
  const calls: unknown[][] = [];
  const app = createCooperativeCentralApp({
    auth: new CentralAuth(supervisors.map((principal, i) => ({ tokenHash: createHash("sha256").update(bearer[i]!).digest("hex"), principal }))),
    identities: { async matches(identity) { return supervisors.some(({ principalId, name, hostId, session }) => JSON.stringify(identity) === JSON.stringify({ principalId, name, hostId, session })); } },
    commands: {
      async submitBounded() { throw new Error("unexpected submit"); },
      async getBounded() { throw new Error("unexpected get"); },
      async listBounded() { throw new Error("unexpected list"); },
    },
    claims: { async claim(...args: unknown[]) {
      calls.push(args);
      if (args[2] === "claim-0") { entered.resolve(); await release.promise; }
      return null;
    } } as unknown as CooperativeClaims,
    lifecycle: { async report() { throw new Error("unexpected report"); } } as unknown as CooperativeLifecycle,
    inspection: { async inspectBounded() { throw new Error("unexpected inspection"); } },
  });
  function call(i: number, signal?: AbortSignal) {
    return app.request("/mcp", {
      method: "POST", signal,
      headers: { authorization: `Bearer ${bearer[i]}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-fleet-incarnation-id": credentials[i]!.incarnationId, "x-fleet-incarnation-token": credentials[i]!.token },
      body: JSON.stringify({ jsonrpc: "2.0", id: `rpc-${i}`, method: "tools/call", params: { name: "cooperative_claim", arguments: { requestId: `claim-${i}` } } }),
    });
  }
  const controller = new AbortController();
  const first = call(0, controller.signal);
  try {
    await entered.promise;
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    const second = await call(1);
    expect(calls.map((args) => args.slice(0, 3))).toEqual([
      [supervisors[0], credentials[0], "claim-0"],
      [supervisors[1], credentials[1], "claim-1"],
    ]);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("rpc-1");
    expect(body.error).toBeUndefined();
    expect(body.result.isError).not.toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toEqual({ command: null });
    release.resolve();
    const firstResponse = await first;
    const firstBody = await firstResponse.json();
    expect(firstResponse.status).toBe(200);
    expect(firstBody.id).toBe("rpc-0");
    expect(JSON.parse(firstBody.result.content[0].text)).toEqual({ command: null });
  } finally {
    release.resolve();
  }
}, 3000);
