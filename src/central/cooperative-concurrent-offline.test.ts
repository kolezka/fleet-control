import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";
import type { CooperativeClaims } from "./cooperative-claims.ts";
import type { CooperativeLifecycle } from "./cooperative-lifecycle.ts";

const supervisors = [
  { role: "supervisor" as const, principalId: "principal-a", name: "supervisor-a", hostId: "host-a", session: "session-a" },
  { role: "supervisor" as const, principalId: "principal-b", name: "supervisor-b", hostId: "host-b", session: "session-b" },
];
const credentials = [
  { incarnationId: "11111111-1111-4111-8111-111111111111", token: "a".repeat(43) },
  { incarnationId: "22222222-2222-4222-8222-222222222222", token: "b".repeat(43) },
];
const bearer = ["bearer-secret-a", "bearer-secret-b"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const operation of ["claim", "report"] as const) {
  test(`overlapping ${operation} requests retain identity and response correlation`, async () => {
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const calls: unknown[][] = [];
    const completion: number[] = [];
    const commands = supervisors.map((principal, i) => ({
      id: `command-${i}`, idempotencyKey: `key-${i}`, hostId: principal.hostId, target: principal.session,
      actor: "operator", text: `work-${i}`, status: "claimed", createdAt: "now", updatedAt: "now",
    }));
    const events = commands.map((command, i) => ({ commandId: command.id, requestId: `report-${i}`, status: "accepted", detail: `detail-${i}`, at: "now" }));
    async function gated(args: unknown[]) {
      calls.push(args);
      const index = supervisors.findIndex((principal) => principal.principalId === (args[0] as typeof principal).principalId);
      if (index < 0) throw new Error("unexpected principal");
      entered[index]!.resolve();
      await release[index]!.promise;
      return index;
    }
    const app = createCooperativeCentralApp({
      auth: new CentralAuth(supervisors.map((principal, i) => ({ tokenHash: hash(bearer[i]!), principal }))),
      identities: { async matches(identity) { return supervisors.some(({ principalId, name, hostId, session }) => JSON.stringify(identity) === JSON.stringify({ principalId, name, hostId, session })); } },
      commands: {
        async submitBounded() { throw new Error("unexpected submit"); },
        async getBounded() { throw new Error("unexpected get"); },
        async listBounded() { throw new Error("unexpected list"); },
      },
      claims: { async claim(...args: unknown[]) { const i = await gated(args); return commands[i]; } } as unknown as CooperativeClaims,
      lifecycle: { async report(...args: unknown[]) { const i = await gated(args); return events[i]; } } as unknown as CooperativeLifecycle,
      inspection: { async inspectBounded() { throw new Error("unexpected inspection"); } },
    });
    async function call(i: number) {
      const args = operation === "claim" ? { requestId: `claim-${i}` } : { commandId: commands[i]!.id, requestId: events[i]!.requestId, status: "accepted", detail: events[i]!.detail };
      const response = await app.request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer[i]}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-fleet-incarnation-id": credentials[i]!.incarnationId, "x-fleet-incarnation-token": credentials[i]!.token },
        body: JSON.stringify({ jsonrpc: "2.0", id: `rpc-${i}`, method: "tools/call", params: { name: `cooperative_${operation}`, arguments: args } }),
      });
      const text = await response.text();
      completion.push(i);
      return { status: response.status, text };
    }
    const first = call(0);
    try {
      await entered[0]!.promise;
      const second = call(1);
      await entered[1]!.promise;
      expect(calls).toHaveLength(2);
      for (let i = 0; i < 2; i++) {
        expect(calls[i]!.slice(0, 2)).toEqual([supervisors[i], credentials[i]]);
        if (operation === "claim") {
          expect(calls[i]![2]).toBe(`claim-${i}`);
          expect(typeof calls[i]![3]).toBe("function");
          expect((calls[i]![3] as (value: unknown) => boolean)(commands[i])).toBe(true);
        } else {
          expect(calls[i]!.slice(2)).toEqual([commands[i]!.id, events[i]!.requestId, "accepted", events[i]!.detail]);
        }
      }
      release[1]!.resolve();
      const secondResponse = await second;
      expect(completion).toEqual([1]);
      release[0]!.resolve();
      const firstResponse = await first;
      expect(completion).toEqual([1, 0]);
      for (const [i, response] of [firstResponse, secondResponse].entries()) {
        expect(response.status).toBe(200);
        for (const secret of [...bearer, ...credentials.map((credential) => credential.token)]) expect(response.text).not.toContain(secret);
        const body = JSON.parse(response.text);
        expect(body.jsonrpc).toBe("2.0");
        expect(body.id).toBe(`rpc-${i}`);
        expect(body.error).toBeUndefined();
        expect(body.result.isError).not.toBe(true);
        expect(JSON.parse(body.result.content[0].text)).toEqual(operation === "claim" ? { command: commands[i] } : { event: events[i] });
      }
    } finally {
      release[0]!.resolve();
      release[1]!.resolve();
    }
  }, 3000);
}
