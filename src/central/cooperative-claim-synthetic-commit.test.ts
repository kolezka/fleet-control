import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import type { CentralCommand } from "./data/commands.ts";
import type { CooperativeClaims } from "./data/cooperative-claims.ts";
import type { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";
import { createCooperativeCentralApp, type CooperativeCommands } from "./cooperative-server.ts";
import { createCooperativeAdapter } from "../host-agent/cooperative-adapter.ts";

const localToken = "a".repeat(43);
const supervisorToken = "b".repeat(43);
const incarnationToken = "c".repeat(43);
const incarnationId = "12345678-1234-4123-8123-123456789abc";

test("a synthetic committed claim containing the local token is hidden by the adapter", async () => {
  await exerciseClaim(`command includes ${localToken}`, true);
});

test("a clean synthetic claim passes through the same MCP envelope", async () => {
  await exerciseClaim("a clean command", false);
});

async function exerciseClaim(text: string, expectHidden: boolean) {
  const principal = { name: "supervisor", role: "supervisor" as const, principalId: "id", hostId: "host", session: "session" };
  const auth = new CentralAuth([{ tokenHash: createHash("sha256").update(supervisorToken).digest("hex"), principal }]);
  const command: CentralCommand = { id: "cmd", idempotencyKey: "key", hostId: "host", target: "session", actor: "operator", text, status: "claimed", createdAt: "now", updatedAt: "now" };
  const commits: string[] = [];
  const safetyResults: boolean[] = [];
  let claimCalls = 0;
  let upstreamCalls = 0;
  const claims = {
    async claim(_principal: unknown, _credential: unknown, requestId: string, safeResponse?: (value: CentralCommand | null) => boolean) {
      claimCalls++;
      if (!safeResponse) throw new Error("missing safety callback");
      const safe = safeResponse({ ...command });
      safetyResults.push(safe);
      if (!safe) throw new Error("unsafe claim response");
      commits.push(requestId);
      return command;
    },
  } as unknown as CooperativeClaims;
  const app = createCooperativeCentralApp({ auth, identities: { async matches() { return true; } }, commands: {} as CooperativeCommands, claims, lifecycle: {} as CooperativeLifecycle, inspection: { async inspectBounded() { return null; } } });
  const adapter = createCooperativeAdapter({
    centralUrl: "https://central.example/mcp", localToken, supervisorToken, incarnationToken, incarnationId,
    centralFetch: async (url, init) => { upstreamCalls++; return app.fetch(new Request(url, init)); },
  });
  const response = await adapter(new Request("http://127.0.0.1/mcp", {
    method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "cooperative_claim", arguments: { requestId: "claim-1" } } }),
  }));
  const body = await response.text();
  const visible = JSON.stringify([...response.headers]) + body;
  for (const secret of [localToken, supervisorToken, incarnationToken, incarnationId]) expect(visible).not.toContain(secret);
  expect(safetyResults).toEqual([true]);
  expect(commits).toEqual(["claim-1"]);
  expect(claimCalls).toBe(1);
  expect(upstreamCalls).toBe(1);
  if (expectHidden) {
    expect(response.status).toBe(502);
    expect(body).toContain("outcome unknown");
    expect(body).toContain("no automatic retry");
  } else {
    expect(response.status).toBe(200);
    const envelope = JSON.parse(body);
    expect(envelope.jsonrpc).toBe("2.0");
    expect(envelope.id).toBe(7);
    expect(envelope.result.isError).not.toBe(true);
    expect(JSON.parse(envelope.result.content[0].text).command).toEqual(command);
  }
}
