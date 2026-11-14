import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { withCooperativeSchema } from "./schema-guard";
import { centralTestDatabaseUrl, withValidatedTestDatabaseUrl } from "../test-database-url.ts";

const url = centralTestDatabaseUrl(process.env);
const authorized = url === "postgres://postgres@127.0.0.1:57507/fleet_control_test";

test("rejects invalid identifiers before opening a transaction", async () => {
  const db = { begin: () => { throw new Error("unexpected transaction"); } } as unknown as SQL;
  for (const name of ["", "public;select 1", 'foo"bar', "UPPER", "pg_catalog", "pg_temp", "information_schema", "x".repeat(64)]) {
    await expect(withCooperativeSchema(db, name, async () => {})).rejects.toThrow("invalid cooperative schema identifier");
  }
});

describe.skipIf(!authorized)("cooperative schema guard on disposable PostgreSQL", () => {
  test("pins each transaction, rejects unsafe roles and requires an exact marker", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const role = `cg_role_${suffix}`, schema = `cg_schema_${suffix}`;
    const admin = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => new SQL(currentUrl));
    let roleCreated = false, schemaCreated = false;
    let db: SQL | undefined;
    try {
      const existing = await admin`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ${role}`;
      const existingSchema = await admin`SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = ${schema}`;
      if (existing.length || existingSchema.length) throw new Error("test role or schema already exists");
      await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOBYPASSRLS`;
      roleCreated = true;
      await admin`CREATE SCHEMA ${admin(schema)}`;
      schemaCreated = true;
      await admin`CREATE TABLE ${admin(schema)}.central_cooperative_schema_marker (version TEXT)`;
      await admin`INSERT INTO ${admin(schema)}.central_cooperative_schema_marker VALUES ('fleet_cooperative_v1')`;
      await admin`GRANT USAGE ON SCHEMA ${admin(schema)} TO ${admin(role)}`;
      await admin`GRANT SELECT ON ${admin(schema)}.central_cooperative_schema_marker TO ${admin(role)}`;
      db = withValidatedTestDatabaseUrl(process.env, url!, (currentUrl) => {
        const roleUrl = new URL(currentUrl);
        roleUrl.username = role;
        return new SQL(roleUrl.toString(), { max: 1 });
      });
      await db`CREATE TEMP TABLE central_cooperative_schema_marker (version TEXT)`;
      await db`INSERT INTO central_cooperative_schema_marker VALUES ('hostile')`;
      const result = await withCooperativeSchema(db, schema, async (tx) => {
        const rows = await tx`SELECT current_user AS role, pg_catalog.current_setting('search_path') AS path, version FROM central_cooperative_schema_marker`;
        return rows[0];
      });
      expect(result).toEqual({ role, path: `pg_catalog,"${schema}",pg_temp`, version: "fleet_cooperative_v1" });
      expect((await db`SHOW search_path`)[0]?.search_path).not.toBe(`pg_catalog,"${schema}",pg_temp`);
      await expect(withCooperativeSchema(admin, schema, async () => {})).rejects.toThrow("unsafe cooperative database role or schema");
      await admin`INSERT INTO ${admin(schema)}.central_cooperative_schema_marker VALUES ('other')`;
      await expect(withCooperativeSchema(db, schema, async () => {})).rejects.toThrow("invalid cooperative schema marker");
      await admin`DELETE FROM ${admin(schema)}.central_cooperative_schema_marker`;
      await expect(withCooperativeSchema(db, schema, async () => {})).rejects.toThrow("invalid cooperative schema marker");
      await admin`INSERT INTO ${admin(schema)}.central_cooperative_schema_marker VALUES ('wrong')`;
      await expect(withCooperativeSchema(db, schema, async () => {})).rejects.toThrow("invalid cooperative schema marker");
      await admin`GRANT CREATE ON SCHEMA ${admin(schema)} TO ${admin(role)}`;
      await expect(withCooperativeSchema(db, schema, async () => {})).rejects.toThrow("unsafe cooperative database role or schema");
      await admin`REVOKE CREATE ON SCHEMA ${admin(schema)} FROM ${admin(role)}`;
      await admin`ALTER SCHEMA ${admin(schema)} OWNER TO ${admin(role)}`;
      await expect(withCooperativeSchema(db, schema, async () => {})).rejects.toThrow("unsafe cooperative database role or schema");
    } finally {
      await db?.close();
      if (schemaCreated) await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
      if (roleCreated) await admin`DROP ROLE ${admin(role)}`;
      await admin.close();
    }
  });
});
