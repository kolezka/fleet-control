import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentralAuth } from "./auth.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";
import type { CooperativeClaims } from "./cooperative-claims.ts";
import type { CooperativeLifecycle } from "./cooperative-lifecycle.ts";

const operator = { name: "operator", role: "operator" as const };
const host = { name: "host-user", role: "host" as const, hostId: "host" };
const supervisor = { name: "supervisor", role: "supervisor" as const, principalId: "supervisor-id", hostId: "host", session: "session" };
const identity = { principalId: supervisor.principalId, name: supervisor.name, hostId: supervisor.hostId, session: supervisor.session };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const inspectionPage = { command: { id: "command one", idempotencyKey: "key", hostId: "host", target: "session", actor: "operator", text: "work", status: "queued" as const, createdAt: "now", updatedAt: "now" }, claim: null, events: [], nextCursor: null };
const assertionPage = { assertions: [], nextCursor: null };

function fixture(identityResult: "active" | "stale" | "throw" = "active") {
  const calls: { operation: string; args: unknown[] }[] = [];
  const identities: unknown[] = [];
  const app = createCooperativeCentralApp({
    auth: new CentralAuth([
      { tokenHash: hash("operator-token"), principal: operator },
      { tokenHash: hash("host-token"), principal: host },
      { tokenHash: hash("supervisor-token"), principal: supervisor },
    ]),
    identities: { async matches(value) { identities.push(value); if (identityResult === "throw") throw new Error("lookup failed"); return identityResult === "active"; } },
    commands: {
      async submitBounded(...args) { calls.push({ operation: "submit", args }); throw new Error("unexpected submit"); },
      async getBounded(...args) { calls.push({ operation: "get", args }); throw new Error("unexpected get"); },
      async listBounded(...args) { calls.push({ operation: "list", args }); throw new Error("unexpected list"); },
    },
    claims: { async claim(...args: unknown[]) { calls.push({ operation: "claim", args }); throw new Error("unexpected claim"); } } as unknown as CooperativeClaims,
    lifecycle: { async report(...args: unknown[]) { calls.push({ operation: "report", args }); throw new Error("unexpected report"); } } as unknown as CooperativeLifecycle,
    inspection: { async inspectBounded(...args) { calls.push({ operation: "inspect", args }); return inspectionPage; } },
    reconciliation: { async listBounded(...args) { calls.push({ operation: "assertions", args }); return assertionPage; } },
  });
  return { app, calls, identities };
}

for (const [label, suffix, operation, page] of [
  ["inspection", "", "inspect", inspectionPage],
  ["assertions", "/assertions", "assertions", assertionPage],
] as const) {
  const path = "/api/commands/command%20one/cooperative" + suffix;
  for (const [scenario, authorization, identityResult, status, error, expectedIdentities] of [
    ["missing bearer", undefined, "active", 401, "unauthorized", []],
    ["invalid bearer", "Bearer invalid-token", "active", 401, "unauthorized", []],
    ["host", "Bearer host-token", "active", 403, "forbidden", []],
    ["active supervisor", "Bearer supervisor-token", "active", 403, "forbidden", [identity]],
    ["stale supervisor", "Bearer supervisor-token", "stale", 401, "unauthorized", [identity]],
    ["throwing identity", "Bearer supervisor-token", "throw", 401, "unauthorized", [identity]],
  ] as const) {
    test(label + " denies " + scenario + " before store access", async () => {
      const f = fixture(identityResult);
      const response = await f.app.request(path, { headers: authorization ? { authorization } : {} });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(f.identities).toEqual([...expectedIdentities]);
      expect(f.calls).toEqual([]);
    });
  }
  test(label + " denies operator with unsafe origin before store access", async () => {
    const f = fixture();
    const response = await f.app.request(path, { headers: { authorization: "Bearer operator-token", origin: "https://unsafe.example" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "unsafe origin" });
    expect(f.identities).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  for (const [query, options] of [["", { limit: 4 }], ["?limit=2&cursor=7", { limit: 2, cursor: "7" }]] as const) {
    test(label + " dispatches authorized operator with " + (query || "default pagination"), async () => {
      const f = fixture();
      const response = await f.app.request(path + query, { headers: { authorization: "Bearer operator-token" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(page);
      expect(f.identities).toEqual([]);
      expect(f.calls).toEqual([{ operation, args: operation === "inspect" ? ["command one", options] : [operator, "command one", options] }]);
    });
  }
}
