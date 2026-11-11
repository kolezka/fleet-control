import { expect, test } from "bun:test";
import { SQL } from "bun";
import { disposableCooperativeRole, cleanupCooperativeRole } from "./disposable-role-fixture.ts";

const url = process.env.CENTRAL_TEST_DATABASE_URL;

test("disposable role rejects non-local URLs before connecting", async () => {
  await expect(disposableCooperativeRole("postgres://postgres@localhost:57507/fleet_control_test")).rejects.toThrow("refusing non-disposable");
  await expect(disposableCooperativeRole("postgres://postgres@127.0.0.1:57507/fleet_control_test?host=example.com")).rejects.toThrow("refusing non-disposable");
  await expect(disposableCooperativeRole("postgres://postgres@127.0.0.1:57507/other")).rejects.toThrow("refusing non-disposable");
});

test("disposable role rejects hostile ambient PGDATABASE before connecting", async () => {
  const previous = process.env.PGDATABASE;
  try {
    process.env.PGDATABASE = "hostile_database";
    await expect(disposableCooperativeRole("postgres://postgres@127.0.0.1:57507/fleet_control_test")).rejects.toThrow("refusing ambient PostgreSQL environment variables");
  } finally {
    if (previous === undefined) delete process.env.PGDATABASE;
    else process.env.PGDATABASE = previous;
  }
});

test("ambiguous fixture close failure does not replace startup failure", async () => {
  const startupError = new Error("startup failed");
  const messages: string[] = [];
  const fixture = { role: "cooperative_runtime_test", runtimeUrl: "", cleanup: async () => { throw new Error("close failed"); } };
  const run = async () => {
    try { throw startupError; }
    finally { await cleanupCooperativeRole(fixture, "cooperative_test_example", true, (message) => messages.push(message)); }
  };
  await expect(run()).rejects.toBe(startupError);
  expect(messages).toEqual([
    "Inspect possible leftover test schema: cooperative_test_example; role: cooperative_runtime_test",
    "Could not close disposable role fixture for cooperative_runtime_test",
  ]);
});

(url ? test : test.skip)("ambiguous startup preserves granted resources and the original failure", async () => {
  const fixture = await disposableCooperativeRole(url!);
  const admin = new SQL(url!);
  const schema = `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const startupError = new Error("startup failed before readiness");
  const diagnostics: string[] = [];
  try {
    await admin`CREATE SCHEMA ${admin(schema)}`;
    await admin`GRANT USAGE ON SCHEMA ${admin(schema)} TO ${admin(fixture.role)}`;
    const run = async () => {
      try { throw startupError; }
      finally { await cleanupCooperativeRole(fixture, schema, true, (message) => diagnostics.push(message)); }
    };
    await expect(run()).rejects.toBe(startupError);
    expect(diagnostics).toEqual([`Inspect possible leftover test schema: ${schema}; role: ${fixture.role}`]);
    expect(await admin`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${schema}`).toHaveLength(1);
    expect(await admin`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${fixture.role}`).toHaveLength(1);
  } finally {
    try { await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`; }
    finally { try { await admin`DROP ROLE IF EXISTS ${admin(fixture.role)}`; } finally { await admin.close(); } }
  }
}, 30000);

(url ? test : test.skip)("disposable fixture creates only a restricted login and removes it", async () => {
  const fixture = await disposableCooperativeRole(url!);
  const admin = new SQL(url!);
  const db = new SQL(fixture.runtimeUrl);
  try {
    const [role] = await db`SELECT current_user AS name, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;
    expect(role).toEqual({ name: fixture.role, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
  } finally {
    try { await db.close(); } finally { try { await fixture.cleanup(); } finally { await admin.close(); } }
  }
  const check = new SQL(url!);
  try { expect(await check`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${fixture.role}`).toHaveLength(0); }
  finally { await check.close(); }
}, 30000);
