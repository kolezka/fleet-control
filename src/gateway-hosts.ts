// The gateway's side of looking after its hosts: token files next to the config, the config file itself
// and the calls to the host. The rules live in application/gateway-hosts.ts.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { newToken } from "./auth.ts";
import { gatewayHostUseCases, GatewayHostError, type GatewayHostsDeps, type GatewayHostUseCases } from "./application/gateway-hosts.ts";
import { GatewayConfigError, parseGatewayConfig, type EnrollHandler, type GatewayConfig } from "./client-gateway.ts";
import { HOST_ID } from "./domain/enrollment.ts";
import { withConfigLock } from "./gateway-config-lock.ts";

type HostEntry = { id: string; tokenFile: string; [k: string]: unknown };

async function writeNew(file: string, text: string, mode: number) {
  const fd = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
  await chmod(file, mode);
}

export function gatewayHostsDeps(configPath: string, config: GatewayConfig, opts: { timeoutMs?: number } = {}): GatewayHostsDeps {
  const dir = dirname(resolve(configPath));
  const readConfig = async () => JSON.parse(await readFile(configPath, "utf8")) as { hosts: HostEntry[] };
  const fileOf = async (id: string) => {
    const entry = (await readConfig()).hosts.find((h) => h.id === id);
    if (!entry) throw new GatewayHostError("not_found", `no host ${id} in the config file`);
    return resolve(dir, entry.tokenFile);
  };
  return {
    known: (id) => {
      const h = config.hosts.find((x) => x.id === id);
      return h ? { name: h.name, url: h.origin } : undefined;
    },
    bearer: (id) => config.credentials.bearer(id),
    newToken,
    // Only a file this gateway made for the host (token-<id> next to the config) is rewritten.
    tokenFile: async (id) => {
      const file = await fileOf(id);
      return { file, own: file === join(dir, `token-${id}`) };
    },
    call: async (url, token, path, body) => {
      const res = await fetch(`${url}${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body), keepalive: false } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        redirect: "manual",
        ...(url.startsWith("https:") ? { tls: { rejectUnauthorized: true } } : {}),
      } as RequestInit);
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    stage: async (id, token) => {
      const staged = join(dir, `token-${id}.new-${randomUUID()}`);
      await writeNew(staged, `${token}\n`, 0o600);
      return staged;
    },
    commit: async (id, staged, token) => {
      await rename(staged, join(dir, `token-${id}`));
      config.credentials.replace(id, token);
    },
    discard: (staged) => rm(staged, { force: true }),
    forget: (id) => withConfigLock(configPath, async () => {
      const json = await readConfig();
      const entry = json.hosts.find((h) => h.id === id);
      const next = { ...json, hosts: json.hosts.filter((h) => h.id !== id) };
      // The same checks as at start; a gateway that can add hosts may end with none.
      parseGatewayConfig(next, dir, { allowNoHosts: true });
      const mode = (await stat(configPath)).mode & 0o777;
      const tmp = `${configPath}.tmp-${randomUUID()}`;
      try {
        await writeNew(tmp, `${JSON.stringify(next, null, 2)}\n`, mode);
        await rename(tmp, configPath);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
      const at = config.hosts.findIndex((h) => h.id === id);
      if (at >= 0) config.hosts.splice(at, 1);
      config.credentials.remove(id);
      const own = entry && resolve(dir, entry.tokenFile) === join(dir, `token-${id}`);
      if (own) await rm(join(dir, `token-${id}`), { force: true });
      return { tokenFileRemoved: Boolean(own) };
    }),
  };
}

const status: Record<GatewayHostError["kind"], number> = { invalid: 400, not_found: 404, conflict: 409, failed: 422 };

// /api/manage: POST /<id>/rotate and POST /<id>/remove. The answer never holds a token.
export function manageHandler(use: GatewayHostUseCases, log: (line: string) => void = (l) => console.error(l)): EnrollHandler {
  return async (method, path, body) => {
    try {
      if (method !== "POST") return { status: 405, body: { error: { kind: "method_not_allowed", message: "method not allowed" } } };
      const m = /^\/([^/]+)\/(rotate|remove)$/.exec(path);
      if (!m || !HOST_ID.test(m[1]!)) return { status: 404, body: { error: { kind: "not_found", message: "not found" } } };
      let input: unknown = {};
      if (body && body.length) {
        try { input = JSON.parse(new TextDecoder().decode(body)); } catch { return { status: 400, body: { error: { kind: "invalid", message: "body is not JSON" } } }; }
      }
      return { status: 200, body: m[2] === "rotate" ? await use.rotate(m[1]!, input) : await use.remove(m[1]!, input) };
    } catch (e) {
      if (e instanceof GatewayHostError) return { status: status[e.kind], body: { error: { kind: e.kind, message: e.message } } };
      if (e instanceof GatewayConfigError) return { status: 409, body: { error: { kind: "conflict", message: e.message } } };
      log(`managing a host failed: ${e instanceof Error ? e.message : String(e)}`);
      return { status: 500, body: { error: { kind: "failed", message: "the change failed; details are in the gateway log" } } };
    }
  };
}

export const gatewayHostManager = (configPath: string, config: GatewayConfig, opts?: { timeoutMs?: number }) =>
  manageHandler(gatewayHostUseCases(gatewayHostsDeps(configPath, config, opts)));
