import { SQL } from "bun";
import { expect, test } from "bun:test";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "../test-database-url.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";

const url = centralTestDatabaseUrl(process.env);
const integration = url ? test : test.skip;

integration("principal IDs keep immutable bindings and retirement tombstones", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const identity = { principalId: crypto.randomUUID(), name: `supervisor-${crypto.randomUUID()}`, hostId: "host-a", session: "session-a" };
  try {
    const registry = new SupervisorIdentityRegistry(db);
    const restarted = new SupervisorIdentityRegistry(other);
    await registry.initialize();
    await restarted.initialize();
    expect(await registry.matches(identity)).toBe(false);
    await registry.enroll(identity);
    expect(await restarted.matches(identity)).toBe(true);
    await restarted.enroll(identity);
    for (const changed of [
      { ...identity, name: "different-name" },
      { ...identity, hostId: "host-b" },
      { ...identity, session: "session-b" },
    ]) {
      expect(await restarted.matches(changed)).toBe(false);
      await expect(restarted.enroll(changed)).rejects.toThrow();
      await expect(restarted.retire(changed)).rejects.toThrow();
    }
    const differentPrincipal = { ...identity, principalId: crypto.randomUUID() };
    expect(await restarted.matches(differentPrincipal)).toBe(false);
    await restarted.enroll(differentPrincipal);
    expect(await restarted.matches(differentPrincipal)).toBe(true);
    await registry.retire(identity);
    await restarted.retire(identity);
    expect(await restarted.matches(identity)).toBe(false);
    expect(await restarted.matches(differentPrincipal)).toBe(true);
    for (const changed of [identity, { ...identity, name: "new-name" }, { ...identity, session: "session-b" }]) {
      await expect(restarted.enroll(changed)).rejects.toThrow();
    }
  } finally {
    await db.close();
    await other.close();
  }
});

integration("concurrent enrollment of different bindings has exactly one winner", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  const other = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  try {
    const first = new SupervisorIdentityRegistry(db);
    const second = new SupervisorIdentityRegistry(other);
    await first.initialize();
    const identity = { principalId: crypto.randomUUID(), name: `supervisor-${crypto.randomUUID()}`, hostId: "host-a", session: "session-a" };
    const rival = { ...identity, name: "rival", hostId: "host-b" };
    const result = await Promise.allSettled([first.enroll(identity), second.enroll(rival)]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(Number(await first.matches(identity)) + Number(await first.matches(rival))).toBe(1);
  } finally {
    await db.close();
    await other.close();
  }
});

integration("invalid identities cannot be enrolled or retired", async () => {
  const db = withValidatedTestDatabaseUrl(process.env, url!, (validatedUrl) => new SQL(validatedUrl));
  try {
    const registry = new SupervisorIdentityRegistry(db);
    await registry.initialize();
    const identity = { principalId: crypto.randomUUID(), name: "name", hostId: "host", session: "session" };
    for (const invalid of [
      { ...identity, principalId: "" },
      { ...identity, principalId: " id" },
      { ...identity, principalId: "id\n" },
      { ...identity, principalId: "id\ud800" },
      { ...identity, name: "name\udc00" },
      { ...identity, hostId: "host\ud800" },
      { ...identity, session: "session\udc00" },
      { ...identity, principalId: "x".repeat(257) },
      { ...identity, name: "" },
      { ...identity, name: " name" },
      { ...identity, hostId: "host\n" },
      { ...identity, session: "x".repeat(257) },
    ]) {
      await expect(registry.enroll(invalid)).rejects.toThrow();
      await expect(registry.retire(invalid)).rejects.toThrow();
      expect(await registry.matches(invalid)).toBe(false);
    }
  } finally {
    await db.close();
  }
});
