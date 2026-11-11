import { SQL } from "bun";
import { randomBytes } from "node:crypto";

export async function cleanupCooperativeRole(
  fixture: Awaited<ReturnType<typeof disposableCooperativeRole>>, schema: string, ambiguous: boolean, report: (message: string) => void = console.error,
) {
  if (!ambiguous) return fixture.cleanup();
  report(`Inspect possible leftover test schema: ${schema}; role: ${fixture.role}`);
  try { await fixture.cleanup({ preserveRole: true }); }
  catch { report(`Could not close disposable role fixture for ${fixture.role}`); }
}

// This helper is for the trusted, disposable local test cluster only.
export async function disposableCooperativeRole(adminUrl: string) {
  let url: URL;
  try { url = new URL(adminUrl); } catch { throw new Error("invalid disposable database URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || url.port !== "57507" || url.pathname !== "/fleet_control_test" || !url.username || url.search || url.hash) {
    throw new Error("refusing non-disposable local database URL");
  }
  const role = `cooperative_runtime_` + randomBytes(16).toString("hex");
  const password = randomBytes(32).toString("hex");
  const admin = new SQL(adminUrl);
  let roleOwned = false;
  const cleanup = async (options?: { preserveRole?: boolean }) => {
    try {
      if (roleOwned && !options?.preserveRole) { await admin`DROP ROLE ${admin(role)}`; roleOwned = false; }
    } finally { await admin.close(); }
  };
  try {
    // Both interpolated literals contain only generated lowercase hexadecimal.
    await admin.unsafe(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    roleOwned = true;
    url.username = role;
    url.password = password;
    return { role, runtimeUrl: url.toString(), cleanup };
  } catch {
    try { await cleanup(); } catch { throw new Error("disposable fixture cleanup failed"); }
    throw new Error("disposable fixture provisioning failed");
  }
}
