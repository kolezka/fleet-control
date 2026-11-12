import { SQL } from "bun";
import { CentralAuth, type Credential } from "./auth.ts";
import { CentralCommands } from "./commands.ts";
import { CentralRequests } from "./requests.ts";
import { SupervisorIdentityRegistry } from "./identity-registry.ts";
import { createCentralApp } from "./server.ts";
import { createHostSocketServer, type HostSocketData } from "./host-socket-server.ts";
import type { Server } from "bun";

type Config = { databaseUrl: string; credentialsFile: string; hostname: "127.0.0.1"; port: number };

export function centralConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.CENTRAL_DATABASE_URL;
  const credentialsFile = env.CENTRAL_CREDENTIALS_FILE;
  if (!databaseUrl?.trim() || !credentialsFile?.trim()) throw new Error("central database URL and credentials file are required");
  if (env.CENTRAL_HOST !== undefined && env.CENTRAL_HOST !== "127.0.0.1") throw new Error("central listener must bind to 127.0.0.1");
  const portText = env.CENTRAL_PORT ?? "4872";
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error("invalid central port");
  return { databaseUrl, credentialsFile, hostname: "127.0.0.1", port: Number(portText) };
}

function parseCredentials(text: string): Credential[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["tokenHash", "principal"].includes(key)) || !item.principal || typeof item.principal !== "object" || Array.isArray(item.principal) || Object.keys(item.principal).some((key) => !["name", "role", "principalId", "hostId", "session"].includes(key)))) {
    throw new Error("invalid credentials");
  }
  return value as Credential[];
}

type Dependencies = {
  readCredentials(path: string): Promise<string>;
  createSql(url: string): SQL;
  serve(options: { hostname: "127.0.0.1"; port: number; fetch: (request: Request, server: Server<HostSocketData>) => Response | undefined | Promise<Response>; websocket: ReturnType<typeof createHostSocketServer>["websocket"] }): Pick<Server<HostSocketData>, "stop">;
};

const defaults: Dependencies = {
  readCredentials: (path) => Bun.file(path).text(),
  createSql: (url) => new SQL(url),
  serve: (options) => Bun.serve(options),
};

export async function startCentral(env: Record<string, string | undefined> = process.env, deps: Dependencies = defaults) {
  const config = centralConfig(env);
  let auth: CentralAuth;
  let credentials: Credential[];
  try {
    credentials = parseCredentials(await deps.readCredentials(config.credentialsFile));
    auth = new CentralAuth(credentials);
  }
  catch { throw new Error("invalid or unreadable central credentials file"); }
  let db: SQL | undefined;
  try {
    db = deps.createSql(config.databaseUrl);
    const commands = new CentralCommands(db);
    const requests = new CentralRequests(db);
    const identityRegistry = new SupervisorIdentityRegistry(db);
    await commands.initialize();
    await requests.initialize();
    await identityRegistry.initialize();
    for (const { principal } of credentials) {
      if (principal.role === "supervisor" && !await identityRegistry.matches(principal)) throw new Error("supervisor identity is not active");
    }
    const hostSocket = createHostSocketServer({ auth, onInventory: () => {} });
    const app = createCentralApp({ auth, commands, requests, identities: identityRegistry, listHosts: hostSocket.listHosts });
    const pending = new Set<Promise<Response>>();
    const server = deps.serve({
      hostname: config.hostname,
      port: config.port,
      fetch: (request, server) => {
        if (new URL(request.url).pathname === "/api/host/socket") return hostSocket.fetch(request, server);
        const task = Promise.resolve(app.fetch(request));
        pending.add(task);
        void task.then(() => pending.delete(task), () => pending.delete(task));
        return task;
      },
      websocket: hostSocket.websocket,
    });
    const pool = db;
    let stopping: Promise<void> | undefined;
    return { server, stop() {
      return stopping ??= (async () => {
        await server.stop(true);
        await Promise.allSettled([...pending]);
        await pool.close();
      })();
    } };
  } catch {
    if (db) { try { await db.close(); } catch { /* Preserve the sanitized startup error. */ } }
    throw new Error("central startup failed");
  }
}

if (import.meta.main) {
  startCentral().catch(() => {
    console.error("central startup failed; check local configuration");
    process.exitCode = 1;
  });
}
