import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";
import type { CooperativeCommands } from "./cooperative-server.ts";
import type { CooperativeClaims } from "./data/cooperative-claims.ts";
import type { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const principal = { name: "supervisor", role: "supervisor" as const, principalId: "id", hostId: "host", session: "session" };

// A wait is a held request. When the client goes away it must stop reading the database,
// not keep polling for up to 20 seconds and hold a stop or a connection slot.
test("cooperative_wait stops polling when the HTTP client disconnects", async () => {
  let polls = 0;
  const claims = { async pending() { polls++; return false; } } as unknown as CooperativeClaims;
  const app = createCooperativeCentralApp({
    auth: new CentralAuth([{ tokenHash: hash("supervisor"), principal }]),
    commands: {} as CooperativeCommands,
    claims,
    lifecycle: {} as CooperativeLifecycle,
    inspection: { async inspectBounded() { return null; } },
    identities: { async matches() { return true; } },
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  try {
    const aborter = new AbortController();
    const call = fetch(new URL("/mcp", server.url), {
      method: "POST",
      signal: aborter.signal,
      headers: {
        authorization: "Bearer supervisor", "content-type": "application/json", accept: "application/json, text/event-stream",
        "x-fleet-incarnation-id": "00000000-0000-4000-8000-000000000001", "x-fleet-incarnation-token": "a".repeat(43),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cooperative_wait", arguments: { waitSeconds: 20 } } }),
    }).catch(() => "aborted");
    for (let i = 0; i < 50 && polls === 0; i++) await Bun.sleep(20);
    expect(polls).toBeGreaterThan(0);
    aborter.abort();
    expect(await call).toBe("aborted");
    // The poll that was sleeping (up to 1 s) sees the abort and returns; none follow.
    await Bun.sleep(1300);
    const settled = polls;
    await Bun.sleep(2200);
    expect(polls).toBe(settled);
    expect(settled).toBeLessThanOrEqual(4);
  } finally {
    server.stop(true);
  }
});
