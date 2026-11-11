/** Test-only URL check. This does not verify the identity of the database listener. */
export function rejectAmbientPostgresEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  if (Object.keys(env).some((key) => key.startsWith("PG") || key === "DATABASE_URL")) {
    throw new Error("refusing ambient PostgreSQL environment variables");
  }
}

export function centralTestDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  rejectAmbientPostgresEnvironment(env);

  const value = env.CENTRAL_TEST_DATABASE_URL;
  if (value === undefined) return undefined;

  // Match the raw URL so URL normalization cannot disguise another address or path.
  if (!/^postgres(?:ql)?:\/\/[^\s\/@?#:]+(?::[^\s\/@?#]*)?@127\.0\.0\.1:57507\/fleet_control_test$(?![\s\S])/.test(value)) {
    throw new Error("refusing non-disposable test database URL");
  }
  try {
    const parsed = new URL(value);
    if (!parsed.username || parsed.hostname !== "127.0.0.1" || parsed.port !== "57507" || parsed.pathname !== "/fleet_control_test") {
      throw new Error();
    }
  } catch {
    throw new Error("refusing non-disposable test database URL");
  }
  return value;
}
