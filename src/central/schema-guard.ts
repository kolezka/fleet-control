import type { SQL, TransactionSQL } from "bun";

const schemaPattern = /^[a-z_][a-z0-9_]{0,62}$/;

/** Checks only the active role, search path and installation marker, not schema integrity or all privileges. */
export async function withCooperativeSchema<T>(db: SQL, schema: string, operation: (tx: TransactionSQL) => Promise<T>): Promise<T> {
  if (!schemaPattern.test(schema) || schema === "pg_catalog" || schema === "information_schema" || schema.startsWith("pg_")) {
    throw new Error("invalid cooperative schema identifier");
  }
  return db.begin(async (tx) => {
    const roles = await tx`SELECT r.rolsuper, r.rolbypassrls, n.oid IS NOT NULL AS schema_exists,
      CASE WHEN n.oid IS NULL THEN TRUE ELSE pg_catalog.pg_has_role(current_user, n.nspowner, 'MEMBER') END AS owns_schema,
      CASE WHEN n.oid IS NULL THEN TRUE ELSE pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE') END AS can_create
      FROM pg_catalog.pg_roles r LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = ${schema}
      WHERE r.rolname = current_user`;
    const role = roles[0];
    if (!role || !role.schema_exists || role.rolsuper || role.rolbypassrls || role.owns_schema || role.can_create) {
      throw new Error("unsafe cooperative database role or schema");
    }
    await tx`SELECT pg_catalog.set_config('search_path', ${`pg_catalog,"${schema}",pg_temp`}, true)`;
    const marker = await tx`SELECT version FROM ${tx(schema)}.central_cooperative_schema_marker`;
    if (marker.length !== 1 || marker[0]?.version !== "fleet_cooperative_v1") {
      throw new Error("invalid cooperative schema marker");
    }
    return operation(tx);
  });
}
