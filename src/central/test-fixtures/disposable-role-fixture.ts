import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { rejectAmbientPostgresEnvironment } from "../test-database-url.ts";

export async function cleanupCooperativeRole(
  fixture: Awaited<ReturnType<typeof disposableCooperativeRole>>, schema: string, ambiguous: boolean, report: (message: string) => void = console.error,
) {
  if (!ambiguous) return fixture.cleanup();
  report(`Inspect possible leftover test schema: ${schema}; role: ${fixture.role}`);
  try { await fixture.cleanup({ preserveRole: true }); }
  catch { report(`Could not close disposable role fixture for ${fixture.role}`); }
}

// This helper is for the trusted, disposable local test cluster only.
export async function disposableCooperativeRole(adminUrl: string, createAdmin: (url: string) => SQL = (url) => new SQL(url)) {
  rejectAmbientPostgresEnvironment(process.env);
  let url: URL;
  try { url = new URL(adminUrl); } catch { throw new Error("invalid disposable database URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || url.port !== "57507" || url.pathname !== "/fleet_control_test" || !url.username || url.search || url.hash) {
    throw new Error("refusing non-disposable local database URL");
  }
  const role = `cooperative_runtime_` + randomBytes(16).toString("hex");
  const password = randomBytes(32).toString("hex");
  const admin = createAdmin(adminUrl);
  let roleOwned = false;
  const cleanup = async (options?: { preserveRole?: boolean }) => {
    const failures: Error[] = [];
    try {
      if (roleOwned && !options?.preserveRole) { await admin`DROP ROLE ${admin(role)}`; roleOwned = false; }
    } catch { failures.push(new Error(`disposable role drop failed: ${role}`)); }
    try { await admin.close(); }
    catch { failures.push(new Error("disposable admin close failed")); }
    if (failures.length) throw new AggregateError(failures, "disposable fixture cleanup failed");
  };
  try {
    // Both interpolated literals contain only generated lowercase hexadecimal.
    await admin.unsafe(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    roleOwned = true;
    url.username = role;
    url.password = password;
    return { role, runtimeUrl: url.toString(), cleanup };
  } catch {
    const provisioningFailure = new Error(`disposable fixture provisioning failed; role creation outcome may be unknown: ${role}`);
    try { await cleanup(); }
    catch (cleanupFailure) {
      throw new AggregateError([provisioningFailure, cleanupFailure], "disposable fixture provisioning and cleanup failed");
    }
    throw provisioningFailure;
  }
}
