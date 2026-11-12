import { describe, expect, test } from "bun:test";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "./test-database-url";

const valid = "postgres://user:password@127.0.0.1:57507/fleet_control_test";

describe("centralTestDatabaseUrl", () => {
  test("returns undefined only for a missing URL", () => {
    expect(centralTestDatabaseUrl({})).toBeUndefined();
    expect(() => centralTestDatabaseUrl({ CENTRAL_TEST_DATABASE_URL: "" })).toThrow();
  });

  test("returns the original valid URL for either PostgreSQL scheme", () => {
    for (const url of [valid, "postgresql://user@127.0.0.1:57507/fleet_control_test", "postgres://user%40name:p%40ss@127.0.0.1:57507/fleet_control_test"]) {
      expect(centralTestDatabaseUrl({ CENTRAL_TEST_DATABASE_URL: url })).toBe(url);
    }
  });

  test("rejects non-exact destinations, malformed inputs and query or fragment delimiters", () => {
    for (const url of [
      "not a url", "https://user@127.0.0.1:57507/fleet_control_test",
      "postgres://127.0.0.1:57507/fleet_control_test", "postgres://:pass@127.0.0.1:57507/fleet_control_test",
      "postgres://user@localhost:57507/fleet_control_test", "postgres://user@127.1:57507/fleet_control_test",
      "postgres://user@127.0.0.1:57508/fleet_control_test", "postgres://user@127.0.0.1:57507/other",
      "postgres://user@127.0.0.1:57507/a/../fleet_control_test",
      "postgres://user@127.0.0.1:57507/fleet_control_test?", "postgres://user@127.0.0.1:57507/fleet_control_test?host=remote",
      "postgres://user@127.0.0.1:57507/fleet_control_test#", "postgres://user@127.0.0.1:57507/fleet_control_test#fragment",
      ` ${valid}`, `${valid}\n`,
    ]) {
      expect(() => centralTestDatabaseUrl({ CENTRAL_TEST_DATABASE_URL: url })).toThrow("refusing non-disposable test database URL");
    }
  });

  test("rejects ambient variable presence even when URL is absent and never exposes values", () => {
    for (const key of ["PGHOST", "PGOPTIONS", "PG", "DATABASE_URL"]) {
      for (const value of ["secret-value", "", undefined]) {
        for (const url of [undefined, valid]) {
          try {
            centralTestDatabaseUrl({ [key]: value, CENTRAL_TEST_DATABASE_URL: url });
            throw new Error("expected rejection");
          } catch (error) {
            expect((error as Error).message).toBe("refusing ambient PostgreSQL environment variables");
            expect((error as Error).message).not.toContain("secret-value");
          }
        }
      }
    }
    expect(centralTestDatabaseUrl({ OTHER: "allowed", CENTRAL_TEST_DATABASE_URL: valid })).toBe(valid);
  });

  test("rechecks the environment before invoking the connection factory", () => {
    const env: Record<string, string | undefined> = { CENTRAL_TEST_DATABASE_URL: valid };
    let calls = 0;
    const connect = (url: string) => { calls++; return url; };
    expect(centralTestDatabaseUrl(env)).toBe(valid);
    env.PGDATABASE = "other";
    expect(() => withValidatedTestDatabaseUrl(env, valid, connect)).toThrow("refusing ambient PostgreSQL environment variables");
    delete env.PGDATABASE;
    env.CENTRAL_TEST_DATABASE_URL = "postgres://user@127.0.0.1:57507/other";
    expect(() => withValidatedTestDatabaseUrl(env, valid, connect)).toThrow();
    env.CENTRAL_TEST_DATABASE_URL = "postgres://other@127.0.0.1:57507/fleet_control_test";
    expect(() => withValidatedTestDatabaseUrl(env, valid, connect)).toThrow("test database URL changed before SQL creation");
    env.CENTRAL_TEST_DATABASE_URL = undefined;
    expect(() => withValidatedTestDatabaseUrl(env, valid, connect)).toThrow();
    expect(calls).toBe(0);
    env.CENTRAL_TEST_DATABASE_URL = valid;
    expect(withValidatedTestDatabaseUrl(env, valid, connect)).toBe(valid);
    expect(calls).toBe(1);
  });

  test("does not expose invalid URL credentials", () => {
    expect(() => centralTestDatabaseUrl({ CENTRAL_TEST_DATABASE_URL: "postgres://secret-value@localhost:57507/fleet_control_test" })).toThrow("refusing non-disposable test database URL");
    try { centralTestDatabaseUrl({ CENTRAL_TEST_DATABASE_URL: "secret-value" }); } catch (error) {
      expect((error as Error).message).not.toContain("secret-value");
    }
  });
});
