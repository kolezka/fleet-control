import { SQL } from "bun";
import { lstat, open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CentralAuth, type Credential } from "./auth.ts";
import { CentralCommands } from "./commands.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { CooperativeClaims } from "./cooperative-claims.ts";
import { CooperativeLifecycle } from "./cooperative-lifecycle.ts";
import { CooperativeInspection } from "./cooperative-inspection.ts";
import { provisionCooperative } from "./cooperative-provision.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";

// Disposable experiment only. The database and all its roles/writers must be trusted.
// This creates a fresh schema and never resumes or migrates an existing one. Stores
// use unqualified SQL on a pinned search_path, not withCooperativeSchema. This is
// not a security boundary, a production installation, or a fence on external work.
// Set COOPERATIVE_DATABASE_URL to a trusted disposable local PostgreSQL database,
// COOPERATIVE_SCHEMA to cooperative_test_<32 lowercase hex>, and
// COOPERATIVE_CREDENTIALS_FILE to a private JSON credentials array, and
// COOPERATIVE_INCARNATION_FILE to an absolute path that does not exist yet. Exactly one
// supervisor and at least one operator are required. The new incarnation secret is
// written once to that file (exclusive create, mode 0600) and never printed.
// No host agent, dispatch, automatic execution, TLS, recovery or cleanup is provided.
export function cooperativeConfig(env: Record<string, string | undefined>) {
  const raw = env.COOPERATIVE_DATABASE_URL;
  const schema = env.COOPERATIVE_SCHEMA;
  const credentialsFile = env.COOPERATIVE_CREDENTIALS_FILE;
  let url: URL;
  try { url = new URL(raw ?? ""); } catch { throw new Error("explicit disposable database URL required"); }
  // Fixed database and port match this repository's disposable PostgreSQL fixture.
  // Refuse connection options, alternate hosts, sockets, and database names.
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) || url.hostname !== "127.0.0.1" || url.port !== "57507" || url.pathname !== "/fleet_control_test" || url.search || url.hash || !url.username) throw new Error("refusing non-disposable local database URL");
  if (!schema || !/^cooperative_test_[a-f0-9]{32}$/.test(schema)) throw new Error("explicit fresh disposable schema required");
  if (!credentialsFile?.trim()) throw new Error("credentials file required");
  const incarnationFile = env.COOPERATIVE_INCARNATION_FILE;
  if (!incarnationFile || !isAbsolute(incarnationFile) || incarnationFile.endsWith("/")) throw new Error("absolute incarnation file path required");
  if (env.COOPERATIVE_HOST !== undefined && env.COOPERATIVE_HOST !== "127.0.0.1") throw new Error("listener must bind to 127.0.0.1");
  const port = env.COOPERATIVE_PORT ?? "4873";
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error("invalid port");
  return { databaseUrl: raw!, schema, credentialsFile, incarnationFile, port: Number(port) };
}

function parseCredentials(text: string): Credential[] {
  const credentials: unknown = JSON.parse(text);
  if (!Array.isArray(credentials) || credentials.some((c) => !c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((k) => !["tokenHash", "principal"].includes(k)) || !c.principal || typeof c.principal !== "object" || Array.isArray(c.principal) || Object.keys(c.principal).some((k) => !["name", "role", "principalId", "hostId", "session"].includes(k)))) throw new Error("invalid credentials");
  new CentralAuth(credentials);
  if (credentials.filter((c) => c.principal.role === "supervisor").length !== 1 || !credentials.some((c) => c.principal.role === "operator") || credentials.some((c) => c.principal.role === "host")) throw new Error("one supervisor and at least one operator required");
  return credentials;
}

async function missing(path: string) {
  try { await lstat(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
}

// Exclusive create: never overwrites. Errors carry no token; a partial file we created is removed.
async function writeIncarnationFile(path: string, credential: { incarnationId: string; token: string }) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ incarnationId: credential.incarnationId, token: credential.token }));
    await handle.close();
  } catch {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw new Error("incarnation file write failed");
  }
}

export async function startCooperative(env: Record<string, string | undefined> = process.env) {
  const config = cooperativeConfig(env);
  // Checked early so no schema is provisioned; the exclusive create below is the real guard.
  if (!(await missing(config.incarnationFile))) throw new Error("incarnation file must not exist");
  let credentials: Credential[];
  try { credentials = parseCredentials(await Bun.file(config.credentialsFile).text()); }
  catch { throw new Error("invalid or unreadable cooperative credentials file"); }
  const auth = new CentralAuth(credentials);
  const supervisor = credentials.find((c) => c.principal.role === "supervisor")!.principal;
  if (supervisor.role !== "supervisor") throw new Error("supervisor required");
  const admin = new SQL(config.databaseUrl);
  let db: SQL | undefined;
  try {
    await provisionCooperative(admin, { testSchema: config.schema });
    await admin.close();
    db = new SQL(config.databaseUrl, { connection: { search_path: config.schema } });
    const [path] = await db`SELECT current_schema() AS name`;
    if (path?.name !== config.schema) throw new Error("unexpected search path");
    const identities = new SupervisorIdentityRegistry(db);
    const incarnations = new SupervisorIncarnations(db);
    await identities.enroll(supervisor);
    const credential = await incarnations.activate(supervisor);
    const app = createCooperativeCentralApp({ auth, identities, commands: new CentralCommands(db), claims: new CooperativeClaims(db, incarnations), lifecycle: new CooperativeLifecycle(db, incarnations), inspection: new CooperativeInspection(db) });
    const pending = new Set<Promise<Response>>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch(request, server) {
      if (request.headers.get("host") !== `127.0.0.1:${server.port}` && request.headers.get("host") !== `localhost:${server.port}`) return new Response("invalid host", { status: 403 });
      const task = Promise.resolve(app.fetch(request));
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    } });
    const pool = db;
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => { await server.stop(true); await Promise.allSettled([...pending]); await pool.close(); })();
    try { await writeIncarnationFile(config.incarnationFile, credential); }
    catch {
      await stop().catch(() => {});
      db = undefined;
      throw new IncarnationFileError();
    }
    return { server, incarnationId: credential.incarnationId, incarnationFile: config.incarnationFile, stop };
  } catch (error) {
    if (error instanceof IncarnationFileError) throw new Error("cooperative startup failed: could not write incarnation file; schema remains and must not be reused");
    await Promise.allSettled([admin.close(), ...(db ? [db.close()] : [])]);
    // The schema may already have been created. Never drop it automatically.
    throw new Error("cooperative startup failed; schema may remain and must not be reused", { cause: error });
  }
}

class IncarnationFileError extends Error {}

// The only stdout line. It must never contain the incarnation token.
export async function runCooperativeCli(env: Record<string, string | undefined> = process.env) {
  const running = await startCooperative(env);
  return { running, line: JSON.stringify({ url: `http://127.0.0.1:${running.server.port}`, incarnationId: running.incarnationId }) };
}

if (import.meta.main) {
  runCooperativeCli().then(({ line }) => { console.log(line); })
    .catch(() => { console.error("cooperative startup failed; check configuration and use a fresh schema"); process.exitCode = 1; });
}
