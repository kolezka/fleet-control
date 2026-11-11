import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AuthConfigError, CentralAuth, authorize, type Credential } from "./auth.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const credentials: Credential[] = [
  { tokenHash: hash("operator-token"), principal: { name: "alice", role: "operator" } },
  { tokenHash: hash("host-token"), principal: { name: "host-agent", role: "host", hostId: "host-a" } },
  { tokenHash: hash("supervisor-token"), principal: { name: "supervisor", role: "supervisor", principalId: "principal-123", hostId: "host-a", session: "session-a" } },
];
const request = (authorization?: string, cookie?: string) => new Request("http://localhost/", { headers: { ...(authorization ? { authorization } : {}), ...(cookie ? { cookie } : {}) } });

describe("central authentication", () => {
  test("accepts only configured bearer tokens and returns configured identity", () => {
    const auth = new CentralAuth(credentials);
    expect(auth.authenticate(request("Bearer operator-token"))).toEqual(credentials[0]!.principal);
    expect(auth.authenticate(request("bearer host-token"))).toEqual(credentials[1]!.principal);
    expect(auth.authenticate(request("Bearer supervisor-token"))).toEqual(credentials[2]!.principal);
    expect(auth.authenticate(request("Bearer wrong"))).toBeNull();
    expect(auth.authenticate(request("Basic operator-token"))).toBeNull();
    expect(auth.authenticate(request("Bearer operator-token extra"))).toBeNull();
    expect(auth.authenticate(request(undefined, "fc_session=operator-token"))).toBeNull();
    expect(auth.authenticate(new Request("http://localhost/", { headers: { "x-actor": "alice" } }))).toBeNull();
    expect(auth.authenticate(request(`Bearer ${"x".repeat(513)}`))).toBeNull();
  });

  test("rejects malformed hashes, duplicate credentials, identities and missing scope", () => {
    const invalid: unknown[] = [[], [{ ...credentials[0], tokenHash: "abcd" }], [{ ...credentials[0], tokenHash: "A".repeat(64) }],
      [credentials[0], { ...credentials[1], tokenHash: credentials[0]!.tokenHash }],
      [credentials[0], { ...credentials[1], principal: { name: "alice", role: "host", hostId: "host-a" } }],
      [{ tokenHash: hash("x"), principal: { name: "x", role: "host" } }],
      [{ tokenHash: hash("x"), principal: { name: "x", role: "supervisor", hostId: "host-a", session: " " } }],
      [{ tokenHash: hash("x"), principal: { name: "", role: "operator" } }],
      [{ tokenHash: hash("x"), principal: { name: "x", role: "unknown" } }]];
    for (const config of invalid) expect(() => new CentralAuth(config as Credential[])).toThrow(AuthConfigError);
  });

  test("rejects malformed Unicode in configured identities and scopes", () => {
    for (const invalid of ["bad\ud800", "bad\udc00"]) {
      for (const principal of [
        { role: "operator", name: invalid },
        { role: "host", name: "host", hostId: invalid },
        { role: "supervisor", name: "supervisor", principalId: invalid, hostId: "host", session: "session" },
        { role: "supervisor", name: "supervisor", principalId: "id", hostId: "host", session: invalid }
      ]) expect(() => new CentralAuth([{ tokenHash: hash("token"), principal }] as Credential[])).toThrow(AuthConfigError);
    }
    expect(() => new CentralAuth([{ tokenHash: hash("token"), principal: { role: "operator", name: "operator 🛰️" } }])).not.toThrow();
  });

  test("requires an explicitly provisioned supervisor ID and preserves it independently of name and token", () => {
    const supervisor = credentials[2]!.principal;
    if (supervisor.role !== "supervisor") throw new Error("expected supervisor");
    for (const principalId of [undefined, "", " ", " id", "id\n", "x".repeat(257)]) {
      expect(() => new CentralAuth([{ tokenHash: hash("token"), principal: { ...supervisor, principalId } }] as Credential[])).toThrow(AuthConfigError);
    }
    expect(() => new CentralAuth([credentials[2]!, { tokenHash: hash("other"), principal: { ...supervisor, name: "other" } }])).toThrow(AuthConfigError);
    const config: Credential[] = [{ tokenHash: hash("rotated-token"), principal: { ...supervisor, name: "renamed" } }];
    const auth = new CentralAuth(config);
    if (config[0]!.principal.role === "supervisor") config[0]!.principal.principalId = "changed";
    const identity = auth.authenticate(request("Bearer rotated-token"));
    expect(identity).toMatchObject({ name: "renamed", principalId: "principal-123" });
    if (identity?.role === "supervisor") identity.principalId = "changed";
    expect(auth.authenticate(request("Bearer rotated-token"))).toMatchObject({ principalId: "principal-123" });
  });

  test("startup validation requires every configured supervisor to be enrolled", async () => {
    const auth = new CentralAuth(credentials);
    const seen: unknown[] = [];
    await auth.validateSupervisors({ async matches(identity) { seen.push(identity); return true; } });
    expect(seen).toEqual([{ name: "supervisor", principalId: "principal-123", hostId: "host-a", session: "session-a" }]);
    await expect(auth.validateSupervisors({ async matches() { return false; } })).rejects.toThrow(AuthConfigError);
    await expect(auth.validateSupervisors({ async matches() { throw new Error("database unavailable"); } })).rejects.toThrow();
    await new CentralAuth([credentials[0]!]).validateSupervisors({ async matches() { throw new Error("unexpected lookup"); } });
  });

  test("authorization requires the exact role and scoped identifiers", () => {
    const auth = new CentralAuth(credentials);
    const operator = auth.authenticate(request("Bearer operator-token"));
    const host = auth.authenticate(request("Bearer host-token"));
    const supervisor = auth.authenticate(request("Bearer supervisor-token"));
    expect(authorize(operator, "operator")).toBe(true);
    expect(authorize(operator, "host", { hostId: "host-a" })).toBe(false);
    expect(authorize(host, "host", { hostId: "host-a" })).toBe(true);
    expect(authorize(host, "host", { hostId: "host-b" })).toBe(false);
    expect(authorize(host, "host")).toBe(false);
    expect(authorize(supervisor, "supervisor", { hostId: "host-a", session: "session-a" })).toBe(true);
    expect(authorize(supervisor, "supervisor", { hostId: "host-a", session: "session-b" })).toBe(false);
    expect(authorize(supervisor, "supervisor", { hostId: "host-b", session: "session-a" })).toBe(false);
    expect(authorize(supervisor, "supervisor", { hostId: "host-a" })).toBe(false);
    expect(authorize(null, "operator")).toBe(false);
  });

  test("copies identities so configuration and callers cannot alter permissions", () => {
    const config: Credential[] = [{ tokenHash: hash("token"), principal: { name: "agent", role: "host", hostId: "a" } }];
    const auth = new CentralAuth(config);
    if (config[0]!.principal.role === "host") config[0]!.principal.hostId = "b";
    const principal = auth.authenticate(request("Bearer token"));
    expect(authorize(principal, "host", { hostId: "a" })).toBe(true);
    if (principal?.role === "host") principal.hostId = "b";
    expect(authorize(auth.authenticate(request("Bearer token")), "host", { hostId: "a" })).toBe(true);
  });
});
