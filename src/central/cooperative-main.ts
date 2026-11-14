import { SQL } from "bun";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CentralAuth } from "./auth.ts";
import type { Credential } from "./domain/identity.ts";
import { CentralCommands } from "./data/commands.ts";
import { SupervisorIdentityRegistry } from "./data/identity-registry.ts";
import { SupervisorIncarnations } from "./data/incarnations.ts";
import { CooperativeClaims } from "./data/cooperative-claims.ts";
import { CooperativeLifecycle } from "./data/cooperative-lifecycle.ts";
import { CooperativeInspection } from "./data/cooperative-inspection.ts";
import { CooperativeReconciliation } from "./data/cooperative-reconciliation.ts";
import { CooperativeSettlement } from "./data/cooperative-settlement.ts";
import { provisionCooperative } from "./data/cooperative-provision.ts";
import { createCooperativeCentralApp } from "./cooperative-server.ts";
import { withCooperativeSchema } from "./data/schema-guard.ts";
import { rejectAmbientPostgresEnvironment } from "./test-database-url.ts";
import { loadTlsFiles, tlsFilesFromEnv } from "./tls-files.ts";
import type { CooperativeTransactionRunner } from "./data/incarnations.ts";

// Disposable experiment only. The database and all its roles/writers must be trusted.
// This creates a fresh schema and never resumes or migrates an existing one. Stores
// use a transaction-bound schema guard with a separate restricted role. This is
// not a security boundary, a production installation, or a fence on external work.
// Set COOPERATIVE_DATABASE_URL to a trusted disposable local PostgreSQL database,
// COOPERATIVE_RUNTIME_DATABASE_URL to a pre-created restricted disposable login,
// COOPERATIVE_SCHEMA to cooperative_test_<32 lowercase hex>, and
// COOPERATIVE_CREDENTIALS_FILE to an absolute path of a private (0600, current user, no
// final symlink) JSON credentials array, and
// COOPERATIVE_INCARNATION_FILE to an absolute path that does not exist yet. Exactly one
// supervisor and at least one operator are required. The new incarnation secret is
// written once to that file (exclusive create, mode 0600) and never printed.
// Optional COOPERATIVE_TLS_CERT_FILE and COOPERATIVE_TLS_KEY_FILE (both, absolute PEM paths)
// serve HTTPS on the same loopback port.
// No host agent, dispatch, automatic execution, recovery or cleanup is provided.
export function cooperativeConfig(env: Record<string, string | undefined>) {
  const raw = env.COOPERATIVE_DATABASE_URL;
  const runtimeRaw = env.COOPERATIVE_RUNTIME_DATABASE_URL;
  const schema = env.COOPERATIVE_SCHEMA;
  const credentialsFile = env.COOPERATIVE_CREDENTIALS_FILE;
  let url: URL;
  try { url = new URL(raw ?? ""); } catch { throw new Error("explicit disposable database URL required"); }
  // Fixed database and port match this repository's disposable PostgreSQL fixture.
  // Refuse connection options, alternate hosts, sockets, and database names.
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) || url.hostname !== "127.0.0.1" || url.port !== "57507" || url.pathname !== "/fleet_control_test" || url.search || url.hash || !url.username) throw new Error("refusing non-disposable local database URL");
  let runtimeUrl: URL;
  try { runtimeUrl = new URL(runtimeRaw ?? ""); } catch { throw new Error("explicit disposable runtime database URL required"); }
  if (!["postgres:", "postgresql:"].includes(runtimeUrl.protocol) || runtimeUrl.hostname !== "127.0.0.1" || runtimeUrl.port !== "57507" || runtimeUrl.pathname !== "/fleet_control_test" || runtimeUrl.search || runtimeUrl.hash || !/^cooperative_runtime_[a-f0-9]{32}$/.test(runtimeUrl.username)) throw new Error("refusing non-disposable runtime database URL");
  if (!schema || !/^cooperative_test_[a-f0-9]{32}$/.test(schema)) throw new Error("explicit fresh disposable schema required");
  if (!credentialsFile?.trim()) throw new Error("credentials file required");
  const incarnationFile = env.COOPERATIVE_INCARNATION_FILE;
  if (!incarnationFile || !isAbsolute(incarnationFile) || incarnationFile.endsWith("/")) throw new Error("absolute incarnation file path required");
  if (env.COOPERATIVE_HOST !== undefined && env.COOPERATIVE_HOST !== "127.0.0.1") throw new Error("listener must bind to 127.0.0.1");
  const port = env.COOPERATIVE_PORT ?? "4873";
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error("invalid port");
  const tls = tlsFilesFromEnv(env.COOPERATIVE_TLS_CERT_FILE, env.COOPERATIVE_TLS_KEY_FILE, "cooperative");
  return { databaseUrl: raw!, runtimeDatabaseUrl: runtimeRaw!, runtimeRole: runtimeUrl.username, schema, credentialsFile, incarnationFile, port: Number(port), ...(tls ? { tls } : {}) };
}

export function parseCredentials(text: string, options: { allowMultipleSupervisors?: boolean } = {}): Credential[] {
  const credentials: unknown = JSON.parse(text);
  if (!Array.isArray(credentials) || credentials.some((c) => !c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((k) => !["tokenHash", "principal"].includes(k)) || !c.principal || typeof c.principal !== "object" || Array.isArray(c.principal) || Object.keys(c.principal).some((k) => !["name", "role", "principalId", "hostId", "session"].includes(k)))) throw new Error("invalid credentials");
  new CentralAuth(credentials);
  const count = credentials.filter((c) => c.principal.role === "supervisor").length;
  if ((options.allowMultipleSupervisors ? count < 1 : count !== 1) || !credentials.some((c) => c.principal.role === "operator") || credentials.some((c) => c.principal.role === "host")) throw new Error(options.allowMultipleSupervisors ? "at least one supervisor and operator required; host credentials forbidden" : "one supervisor and at least one operator required");
  return credentials;
}

// Same checks as the adapter config: absolute path, no final symlink, regular file owned by
// this user with no group or other access, at most 1 MiB.
export async function readPrivateText(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("credentials path must be absolute");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const limit = 1024 * 1024;
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > limit) throw new Error("credentials file must be private");
    const bytes = new Uint8Array(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("credentials file too large");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
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

// How long stop() lets accepted requests finish and reply before force-closing connections.
export const CENTRAL_SHUTDOWN_GRACE_MS = 10_000;

export async function startCooperative(env: Record<string, string | undefined> = process.env, options: { shutdownGraceMs?: number } = {}) {
  const config = cooperativeConfig(env);
  const shutdownGraceMs = options.shutdownGraceMs ?? CENTRAL_SHUTDOWN_GRACE_MS;
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 1 || shutdownGraceMs > 2_147_483_647) throw new Error("invalid shutdown grace");
  rejectAmbientPostgresEnvironment(process.env);
  // Checked early so no schema is provisioned; the exclusive create below is the real guard.
  if (!(await missing(config.incarnationFile))) throw new Error("incarnation file must not exist");
  let credentials: Credential[];
  try { credentials = parseCredentials(await readPrivateText(config.credentialsFile)); }
  catch { throw new Error("invalid or unreadable cooperative credentials file"); }
  // Before provisioning, so a bad certificate never creates a schema.
  const tls = config.tls ? await loadTlsFiles(config.tls, "cooperative") : undefined;
  rejectAmbientPostgresEnvironment(process.env);
  const admin = new SQL(config.databaseUrl);
  try {
    await provisionCooperative(admin, { testSchema: config.schema, runtimeRole: config.runtimeRole });
  } catch (error) {
    await admin.close().catch(() => {});
    throw new Error("cooperative startup failed; schema may remain and must not be reused", { cause: error });
  }
  await admin.close();
  try {
    const running = await serveCooperative({ runtimeDatabaseUrl: config.runtimeDatabaseUrl, schema: config.schema, credentials, tls, hostname: "127.0.0.1", port: config.port, shutdownGraceMs, persist: (credential) => writeIncarnationFile(config.incarnationFile, credential), incarnationFile: config.incarnationFile });
    return { ...running, incarnationId: running.incarnationId! };
  } catch (error) {
    if (error instanceof IncarnationFileError) throw new Error("cooperative startup failed: could not write incarnation file; schema remains and must not be reused");
    // The schema may already have been created. Never drop it automatically.
    throw new Error("cooperative startup failed; schema may remain and must not be reused", { cause: error });
  }
}

// Shared by the disposable entry point and the persistent service. Opens the runtime pool on an
// already provisioned schema and enrolls all supervisors. With persist it requires exactly one and activates a new
// incarnation (fencing the previous one) and hands its secret to persist after the listener is
// up. Without persist no incarnation changes, so a service restart fences nothing. Never provisions.
export async function serveCooperative(options: {
  runtimeDatabaseUrl: string; schema: string; credentials: Credential[]; tls?: Awaited<ReturnType<typeof loadTlsFiles>>;
  hostname: "127.0.0.1" | "0.0.0.0"; port: number; shutdownGraceMs: number; incarnationFile?: string;
  persist?: (credential: { incarnationId: string; token: string }) => Promise<void>;
  allowedHosts?: string[];
}) {
  const { schema, tls, port, shutdownGraceMs } = options;
  const auth = new CentralAuth(options.credentials);
  const supervisors = options.credentials.map((c) => c.principal).filter((p) => p.role === "supervisor");
  if (!supervisors.length) throw new Error("supervisor required");
  if (options.persist && supervisors.length !== 1) throw new Error("persist requires exactly one supervisor");
  let db: SQL | undefined;
  try {
    rejectAmbientPostgresEnvironment(process.env);
    db = new SQL(options.runtimeDatabaseUrl);
    const pool = db;
    const runner: CooperativeTransactionRunner = (operation) => withCooperativeSchema(pool, schema, operation);
    await runner(async () => undefined);
    const identities = new SupervisorIdentityRegistry(db, runner);
    const incarnations = new SupervisorIncarnations(db, runner);
    for (const supervisor of supervisors) await identities.enroll(supervisor);
    const credential = options.persist ? await incarnations.activate(supervisors[0]!) : undefined;
    const commands = new CentralCommands(db, undefined, runner);
    const app = createCooperativeCentralApp({ auth, identities, commands, claims: new CooperativeClaims(db, incarnations, undefined, runner), lifecycle: new CooperativeLifecycle(db, incarnations, undefined, runner), inspection: new CooperativeInspection(db, runner), reconciliation: new CooperativeReconciliation(db, undefined, runner), settlement: new CooperativeSettlement(db, undefined, runner) });
    const pending = new Set<Promise<Response>>();
    const server = Bun.serve({ hostname: options.hostname, port, ...(tls ? { tls } : {}), fetch(request, server) {
      if (request.headers.get("host") !== `127.0.0.1:${server.port}` && request.headers.get("host") !== `localhost:${server.port}` && !options.allowedHosts?.includes(request.headers.get("host") ?? "")) return new Response("invalid host", { status: 403 });
      const task = Promise.resolve(app.fetch(request));
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    } });
    let stopping: Promise<void> | undefined;
    // Stop accepting, let accepted requests reply until the grace deadline, then force-close.
    // server.stop(false) can resolve while a handler for a gone client still runs, so also wait
    // on pending. SQL work is always awaited (unbounded) before the pool closes under it.
    const stop = () => stopping ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), shutdownGraceMs); });
      try {
        const drained = await Promise.race([Promise.allSettled([server.stop(false), ...pending]).then(() => true), deadline]);
        if (!drained) await server.stop(true);
      } finally {
        clearTimeout(timer);
        await Promise.allSettled([...pending]);
        await pool.close();
      }
    })();
    try { if (options.persist && credential) await options.persist(credential); }
    catch {
      await stop().catch(() => {});
      db = undefined;
      throw new IncarnationFileError();
    }
    return { server, url: `${tls ? "https" : "http"}://127.0.0.1:${server.port}`, incarnationId: credential?.incarnationId, incarnationFile: options.incarnationFile, stop };
  } catch (error) {
    if (db) await db.close().catch(() => {});
    throw error;
  }
}

export class IncarnationFileError extends Error {}

// The only stdout line. It must never contain the incarnation token.
export async function runCooperativeCli(env: Record<string, string | undefined> = process.env) {
  const running = await startCooperative(env);
  return { running, line: JSON.stringify({ url: running.url, incarnationId: running.incarnationId }) };
}

// SIGINT or SIGTERM starts a graceful stop. Both listeners are removed once stopping begins,
// so a second signal gets the default action and kills the process immediately.
if (import.meta.main) {
  runCooperativeCli().then(({ running, line }) => {
    console.log(line);
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      running.stop().catch(() => { console.error("cooperative shutdown failed; in-flight outcomes may be unknown"); process.exitCode = 1; });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }, () => { console.error("cooperative startup failed; check configuration and use a fresh schema"); process.exitCode = 1; });
}
