// The gateway's side of adding a host: token files next to the config, the config file itself,
// the identity check against the new host and the optional SSH run. The rules live in
// application/enrollment.ts; this file only touches disk, network and processes.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { newToken } from "./auth.ts";
import { enrollUseCases, type EnrollDeps, type EnrollUseCases } from "./application/enrollment.ts";
import { EnrollError, HOST_ID } from "./domain/enrollment.ts";
import { GatewayConfigError, parseGatewayConfig, type EnrollHandler, type GatewayConfig } from "./client-gateway.ts";

// Adds one host to a running gateway: the in-memory list and credentials, then the config file.
export function gatewayHostAdder(configPath: string, config: GatewayConfig) {
  return async (host: { id: string; name: string; url: string; tokenFile: string }, token: string) => {
    const json = JSON.parse(await readFile(configPath, "utf8")) as { hosts: unknown[] };
    const entry = { id: host.id, name: host.name, url: host.url, tokenFile: host.tokenFile };
    const next = { ...json, hosts: [...json.hosts, entry] };
    // The same checks the gateway runs at start, so the file stays loadable.
    const parsed = parseGatewayConfig(next, dirname(configPath));
    if (config.hosts.some((h) => h.id === host.id)) throw new GatewayConfigError(`host id ${host.id} is already in use`);
    const mode = (await stat(configPath)).mode & 0o777;
    const tmp = `${configPath}.tmp-${process.pid}`;
    const fd = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await fd.writeFile(`${JSON.stringify(next, null, 2)}\n`); await fd.sync(); } finally { await fd.close(); }
    await chmod(tmp, mode);
    await rename(tmp, configPath);
    const added = parsed.find((h) => h.id === host.id)!;
    config.credentials.add(host.id, token);
    config.hosts.push({ id: added.id, name: added.name, origin: added.origin });
  };
}

export function enrollDeps(configPath: string, config: GatewayConfig, opts: { timeoutMs?: number; ssh?: boolean } = {}): EnrollDeps {
  const dir = dirname(configPath);
  return {
    newToken,
    knownIds: () => config.hosts.map((h) => h.id),
    writeToken: async (id, token) => {
      const file = join(dir, `token-${id}`);
      // wx: never overwrite a token another host still uses.
      const fd = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await fd.writeFile(`${token}\n`); await fd.sync(); } finally { await fd.close(); }
      return file;
    },
    removeToken: (file) => rm(file, { force: true }),
    whoami: async (url, token) => {
      const res = await fetch(`${url}/api/whoami`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        redirect: "manual",
        tls: { rejectUnauthorized: true },
      });
      const body = res.status === 200 ? await res.json().catch(() => null) : null;
      return { status: res.status, body };
    },
    addHost: gatewayHostAdder(configPath, config),
    ...(opts.ssh === false ? {} : {
      ssh: (target, port, command) => new Promise((resolve) => {
        // A non-interactive SSH shell often lacks Bun's folder on PATH.
        const remote = `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"; ${command}`;
        const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", ...(port ? ["-p", String(port)] : []), "--", target, remote], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        const take = (b: Buffer) => { output = (output + b.toString("utf8")).slice(-16_000); };
        child.stdout.on("data", take);
        child.stderr.on("data", take);
        const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
        child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output }); });
        child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, output: e.message }); });
      }),
    }),
  };
}

export const gatewayEnrollment = (configPath: string, config: GatewayConfig, opts?: { timeoutMs?: number; ssh?: boolean }) => enrollHandler(enrollUseCases(enrollDeps(configPath, config, opts)));

// /api/enroll: GET lists hosts being added; POST starts one; POST /<id>/ssh|check|cancel acts on it.
// The answer never holds a token, only the command with the hash.
export function enrollHandler(use: EnrollUseCases, log: (line: string) => void = (l) => console.error(l)): EnrollHandler {
  return async (method, path, body) => {
    try {
      if (path === "" && method === "GET") return { status: 200, body: { pending: use.list() } };
      if (method !== "POST") return { status: 405, body: { error: { kind: "method_not_allowed", message: "method not allowed" } } };
      let input: unknown = {};
      if (body && body.length) {
        try { input = JSON.parse(new TextDecoder().decode(body)); } catch { return { status: 400, body: { error: { kind: "invalid", message: "body is not JSON" } } }; }
      }
      if (path === "") return { status: 201, body: { pending: await use.begin(input) } };
      const m = /^\/([^/]+)\/(ssh|check|cancel)$/.exec(path);
      if (!m || !HOST_ID.test(m[1]!)) return { status: 404, body: { error: { kind: "not_found", message: "not found" } } };
      const [, id, action] = m;
      if (action === "ssh") return { status: 200, body: await use.runSsh(id!) };
      if (action === "check") return { status: 200, body: await use.check(id!) };
      return { status: 200, body: await use.cancel(id!) };
    } catch (e) {
      if (e instanceof EnrollError) return { status: 400, body: { error: { kind: "invalid", message: e.message } } };
      if (e instanceof GatewayConfigError || (e as NodeJS.ErrnoException).code === "EEXIST") return { status: 409, body: { error: { kind: "conflict", message: e instanceof GatewayConfigError ? e.message : "a token file for this host id already exists next to the config" } } };
      log(`adding a host failed: ${e instanceof Error ? e.message : String(e)}`);
      return { status: 500, body: { error: { kind: "failed", message: "adding the host failed; details are in the gateway log" } } };
    }
  };
}
