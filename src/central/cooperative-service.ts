import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CENTRAL_SHUTDOWN_GRACE_MS, parseCredentials, readPrivateText, serveCooperative } from "./cooperative-main.ts";
import { provisionCooperative, SERVICE_RUNTIME_ROLE } from "./cooperative-provision.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { SupervisorIncarnations } from "./incarnations.ts";
import { withCooperativeSchema } from "./schema-guard.ts";
import { rejectAmbientPostgresEnvironment } from "./test-database-url.ts";
import { loadTlsFiles, tlsFilesFromEnv } from "./tls-files.ts";

// Persistent cooperative central for one trusted installation (docker compose in deploy/cooperative).
// Unlike cooperative-main.ts it never creates a schema at startup and never rotates the supervisor
// incarnation on restart. Commands, all reading private files only:
//   init       once: writes new secrets into COOPERATIVE_STATE_DIR (all exclusive, 0600), split so
//              each container sees only what it needs: pg/ (postgres password, data), admin/ (admin
//              URL, used only by one-shot commands), service/ (credentials with token hashes and,
//              after provision, the runtime URL: the only directory the listener mounts) and
//              client/ (operator and local tokens, adapter config, incarnation). Nothing is printed.
//   provision  once: creates schema fleet_cooperative_v1 and role fleet_cooperative_runtime in one
//              transaction with the admin URL, then writes the runtime URL file (exclusive, 0600).
//   activate   explicit: enrolls the supervisor and activates a new incarnation, fencing the previous
//              one, and writes the incarnation file (exclusive, 0600). The adapter reads that file.
//   serve      runs the HTTP/MCP listener with the restricted runtime role.
// Database URLs live in files, never in the environment, and are never printed.
export const SERVICE_SCHEMA = "fleet_cooperative_v1";

const absolute = (value: string | undefined, label: string) => {
  if (!value || !isAbsolute(value) || value.endsWith("/")) throw new Error(`absolute ${label} path required`);
  return value;
};

function databaseUrl(text: string, role?: string): string {
  const value = text.trim();
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid database URL file"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2 || url.search || url.hash) throw new Error("invalid database URL file");
  if (role !== undefined && decodeURIComponent(url.username) !== role) throw new Error("database URL file must use the service runtime role");
  return value;
}

export function serviceConfig(env: Record<string, string | undefined>) {
  const host = env.COOPERATIVE_HOST ?? "127.0.0.1";
  // 0.0.0.0 is only for the container network; compose publishes the port on host loopback.
  if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new Error("listener must bind to 127.0.0.1 or, inside a container, 0.0.0.0");
  const port = env.COOPERATIVE_PORT ?? "";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("explicit port required");
  const externalHost = env.COOPERATIVE_EXTERNAL_HOST || undefined;
  if (externalHost !== undefined) {
    const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*):([1-9][0-9]{0,4})$/.exec(externalHost);
    if (!match || match[0] !== externalHost || match[1]!.length > 253 || Number(match[2]) > 65535) throw new Error("external Host must be an exact lowercase hostname:port");
  }
  const tls = tlsFilesFromEnv(env.COOPERATIVE_TLS_CERT_FILE, env.COOPERATIVE_TLS_KEY_FILE, "cooperative");
  return {
    runtimeUrlFile: absolute(env.COOPERATIVE_RUNTIME_URL_FILE, "runtime URL file"),
    credentialsFile: absolute(env.COOPERATIVE_CREDENTIALS_FILE, "credentials file"),
    externalHost, host: host as "127.0.0.1" | "0.0.0.0", port: Number(port), ...(tls ? { tls } : {}),
  };
}

async function writeExclusive(path: string, text: string) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); await handle.close(); }
  catch { await handle.close().catch(() => {}); await unlink(path).catch(() => {}); throw new Error(`could not write ${path}`); }
}

const validName = (value: string | undefined, label: string) => {
  if (!value || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error(`${label} must be 1-64 characters [A-Za-z0-9._-]`);
  return value;
};

// COOPERATIVE_STATE_DIR is this process's view of the directory; COOPERATIVE_HOST_STATE_DIR is the
// same directory as the host adapter sees it (differs inside a container). The adapter reaches
// central on host loopback at COOPERATIVE_PORT.
export const STATE_LAYOUT = {
  postgresPassword: "pg/password", adminUrl: "admin/admin-url", runtimeUrl: "service/runtime-url", credentials: "service/credentials.json",
  operatorToken: "client/operator-token", localToken: "client/local-token", adapter: "client/adapter.json", incarnation: "client/incarnation.json",
} as const;

export async function initService(env: Record<string, string | undefined>) {
  const dir = absolute(env.COOPERATIVE_STATE_DIR, "state directory");
  const hostDir = absolute(env.COOPERATIVE_HOST_STATE_DIR ?? dir, "host state directory");
  const port = env.COOPERATIVE_PORT ?? "";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("explicit port required");
  const hostId = validName(env.COOPERATIVE_SUPERVISOR_HOST, "supervisor host");
  const session = validName(env.COOPERATIVE_SUPERVISOR_SESSION ?? "supervisor", "supervisor session");
  const database = validName(env.COOPERATIVE_DATABASE ?? "fleet", "database name");
  const dbHost = validName(env.COOPERATIVE_DATABASE_HOST ?? "postgres", "database host");
  // The top directory may be a bind mount owned elsewhere (setup.sh makes it 0700 on the host).
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const sub of ["pg", "admin", "service", "client"]) {
    await mkdir(join(dir, sub), { recursive: true, mode: 0o700 });
    await chmod(join(dir, sub), 0o700);
  }
  const secret = () => randomBytes(32).toString("base64url");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const postgres = randomBytes(32).toString("hex");
  const operator = secret(), supervisor = secret(), local = secret();
  const L = STATE_LAYOUT;
  const files: [string, string][] = [
    [L.postgresPassword, postgres],
    [L.adminUrl, `postgres://postgres:${postgres}@${dbHost}:5432/${database}`],
    [L.credentials, JSON.stringify([
      { tokenHash: hash(operator), principal: { role: "operator", name: "operator" } },
      { tokenHash: hash(supervisor), principal: { role: "supervisor", name: `supervisor-${hostId}`, principalId: `supervisor-${hostId}-${session}`, hostId, session } },
    ])],
    [L.operatorToken, operator],
    [L.localToken, local],
    // Written last: its presence means init finished.
    [L.adapter, JSON.stringify({ centralUrl: `http://127.0.0.1:${port}/mcp`, localToken: local, supervisorToken: supervisor, incarnationFile: join(hostDir, L.incarnation) })],
  ];
  // Refuse before writing anything if any file exists.
  for (const [name] of files) {
    const handle = await open(join(dir, name), "wx", 0o600).catch((error) => {
      throw new Error((error as NodeJS.ErrnoException)?.code === "EEXIST" ? `${name} already exists; init runs once` : `cannot create ${name} in the state directory`);
    });
    await handle.close();
    await unlink(join(dir, name));
  }
  for (const [name, text] of files) await writeExclusive(join(dir, name), text);
}

export async function provisionService(env: Record<string, string | undefined>) {
  rejectAmbientPostgresEnvironment(process.env);
  const adminUrl = databaseUrl(await readPrivateText(absolute(env.COOPERATIVE_ADMIN_URL_FILE, "admin URL file")));
  const runtimeUrlFile = absolute(env.COOPERATIVE_RUNTIME_URL_FILE, "runtime URL file");
  const password = randomBytes(32).toString("hex");
  const runtime = new URL(adminUrl);
  runtime.username = SERVICE_RUNTIME_ROLE;
  runtime.password = password;
  // Reserve the file first and write it before COMMIT, so a committed role always has its password
  // on disk. A crash after the write but before COMMIT leaves the file without a role: see README.
  const handle = await open(runtimeUrlFile, "wx", 0o600);
  const admin = new SQL(adminUrl);
  try {
    await provisionCooperative(admin, { runtimePassword: password, beforeCommit: async () => {
      await handle.writeFile(runtime.href);
      await handle.sync();
    } });
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(runtimeUrlFile).catch(() => {});
    throw new Error("provisioning failed; nothing is reused automatically", { cause: error });
  } finally {
    await admin.close().catch(() => {});
  }
}

export async function activateService(env: Record<string, string | undefined>) {
  rejectAmbientPostgresEnvironment(process.env);
  const runtimeUrl = databaseUrl(await readPrivateText(absolute(env.COOPERATIVE_RUNTIME_URL_FILE, "runtime URL file")), SERVICE_RUNTIME_ROLE);
  const credentials = parseCredentials(await readPrivateText(absolute(env.COOPERATIVE_CREDENTIALS_FILE, "credentials file")), { allowMultipleSupervisors: true });
  const incarnationFile = absolute(env.COOPERATIVE_INCARNATION_FILE, "incarnation file");
  const supervisors = credentials.map((c) => c.principal).filter((p) => p.role === "supervisor");
  const host = env.COOPERATIVE_SUPERVISOR_HOST, session = env.COOPERATIVE_SUPERVISOR_SESSION;
  const selected = host === undefined && session === undefined && supervisors.length === 1
    ? supervisors
    : supervisors.filter((p) => p.hostId === host && p.session === session);
  if (selected.length !== 1) throw new Error("supervisor selection requires an explicit matching COOPERATIVE_SUPERVISOR_HOST and COOPERATIVE_SUPERVISOR_SESSION");
  const supervisor = selected[0]!;
  // Reserve the file before fencing, so a write failure cannot leave only an unknown secret.
  const handle = await open(incarnationFile, "wx", 0o600);
  const db = new SQL(runtimeUrl);
  try {
    const runner = <T>(operation: (tx: import("bun").TransactionSQL) => Promise<T>) => withCooperativeSchema(db, SERVICE_SCHEMA, operation);
    await new SupervisorIdentityRegistry(db, runner).enroll(supervisor);
    const credential = await new SupervisorIncarnations(db, runner).activate(supervisor);
    try { await handle.writeFile(JSON.stringify({ incarnationId: credential.incarnationId, token: credential.token })); await handle.sync(); await handle.close(); }
    catch { throw new Error("incarnation activated but its file could not be written; activate again"); }
    return { incarnationId: credential.incarnationId };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(incarnationFile).catch(() => {});
    throw error;
  } finally {
    await db.close().catch(() => {});
  }
}

export async function startService(env: Record<string, string | undefined>, options: { shutdownGraceMs?: number } = {}) {
  const config = serviceConfig(env);
  const shutdownGraceMs = options.shutdownGraceMs ?? CENTRAL_SHUTDOWN_GRACE_MS;
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 1 || shutdownGraceMs > 2_147_483_647) throw new Error("invalid shutdown grace");
  rejectAmbientPostgresEnvironment(process.env);
  const runtimeUrl = databaseUrl(await readPrivateText(config.runtimeUrlFile), SERVICE_RUNTIME_ROLE);
  const credentials = parseCredentials(await readPrivateText(config.credentialsFile), { allowMultipleSupervisors: true });
  const tls = config.tls ? await loadTlsFiles(config.tls, "cooperative") : undefined;
  return serveCooperative({ runtimeDatabaseUrl: runtimeUrl, schema: SERVICE_SCHEMA, credentials, tls, hostname: config.host, port: config.port, shutdownGraceMs, allowedHosts: config.externalHost ? [config.externalHost] : undefined });
}

if (import.meta.main) {
  const command = process.argv[2];
  const fail = (message: string) => { console.error(message); process.exitCode = 1; };
  if (command === "init") initService(process.env).then(() => console.log(JSON.stringify({ initialized: true })), (error) => fail(`cooperative init failed: ${error instanceof Error ? error.message : "unknown"}`));
  else if (command === "provision") provisionService(process.env).then(() => console.log(JSON.stringify({ provisioned: SERVICE_SCHEMA })), () => fail("cooperative provisioning failed"));
  else if (command === "activate") activateService(process.env).then((result) => console.log(JSON.stringify(result)), () => fail("cooperative activation failed"));
  else if (command === "serve") startService(process.env).then((running) => {
    console.log(JSON.stringify({ port: running.server.port }));
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      running.stop().catch(() => fail("cooperative shutdown failed; in-flight outcomes may be unknown"));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }, () => fail("cooperative service startup failed"));
  else fail("usage: cooperative-service.ts init|provision|activate|serve");
}
