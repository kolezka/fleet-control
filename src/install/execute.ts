import { constants } from "node:fs";
import { lstat, open, mkdir, access } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";
import { X509Certificate } from "node:crypto";
import { createCooperativeAdapter } from "../host-agent/cooperative-adapter.ts";
import { parseWakerConfig } from "../host-agent/waker.ts";
import { loadGatewayConfig, parseGatewayConfig, parseGatewayCentralConfig } from "../client-gateway.ts";
import { absolute, InstallError, type Plan } from "./plan.ts";

export type ExecutionIO = { run: (argv: string[], cwd: string, env: Record<string, string>, capture?: boolean) => Promise<{ code: number; output: string }> };
export const executionIO: ExecutionIO = {
  async run(argv, cwd, env, capture = false) {
    const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    // Only inspection output is retained; never interrupt a mutation for log volume.
    let output = "";
    for await (const chunk of child.stdout) {
      if (!capture) continue;
      if (output.length + chunk.length > 65536) { child.kill(); await child.exited; throw new InstallError("process output exceeded limit"); }
      output += new TextDecoder().decode(chunk);
    }
    return { code: await child.exited, output };
  },
};
export function cleanEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK"]) if (env[key]) result[key] = env[key]!;
  return result;
}
export async function safePath(path: string, missing = false): Promise<void> {
  absolute(path);
  let cursor = parsePath(path).root;
  const parts = path.slice(cursor.length).split("/");
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || i < parts.length - 1 && !stat.isDirectory()) throw new InstallError("symlink or invalid path component refused");
      if (stat.isDirectory() && (stat.mode & 0o022) && !(stat.mode & 0o1000)) throw new InstallError("writable path ancestor refused");
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
async function absent(path: string) {
  await safePath(path, true);
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new InstallError("pre-existing installation refused; no overwrite or recovery");
}
async function privateText(path: string): Promise<string> {
  await safePath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 65536) throw new InstallError("private configuration required");
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new InstallError("configuration too large");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await file.close(); }
}
async function privateJson(path: string): Promise<Record<string, string>> {
  const value = JSON.parse(await privateText(path));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InstallError("invalid configuration");
  return value;
}
export async function validateConfig(role: string, path: string): Promise<void> {
  const config = await privateJson(path);
  if (role === "client") {
    const hosts = parseGatewayConfig(config, dirname(path));
    const central = parseGatewayCentralConfig(config, dirname(path));
    for (const tokenPath of [...hosts.map(host => host.tokenFile), ...(central ? [central.tokenFile] : [])]) await privateText(tokenPath);
    await loadGatewayConfig(path);
    return;
  }
  if (role === "waker") {
    let waker;
    try { waker = parseWakerConfig(config); } catch { throw new InstallError("invalid configuration"); }
    // Only the program is checked here; its own MCP configuration is the agent's business.
    await safePath(waker.command[0]!);
    await access(waker.command[0]!, constants.X_OK);
    return;
  }
  const keys = ["centralUrl", "localToken", "supervisorToken", "incarnationFile"];
  if (Object.keys(config).some(k => ![...keys, "centralCaFile"].includes(k)) || !keys.every(k => typeof config[k] === "string")) throw new InstallError("invalid configuration");
  const central = new URL(config.centralUrl!);
  if (central.protocol !== "https:" && !(central.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(central.hostname))) throw new InstallError("invalid configuration");
  const incarnation = await privateJson(config.incarnationFile!);
  if (Object.keys(incarnation).length !== 2 || typeof incarnation.incarnationId !== "string" || typeof incarnation.token !== "string") throw new InstallError("invalid configuration");
  if (config.centralCaFile !== undefined) {
    if (typeof config.centralCaFile !== "string" || central.protocol !== "https:") throw new InstallError("invalid configuration");
    await safePath(config.centralCaFile);
    const file = await open(config.centralCaFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536) throw new InstallError("invalid CA file");
      new X509Certificate(await file.readFile());
    } finally { await file.close(); }
  }
  createCooperativeAdapter({ centralUrl: config.centralUrl!, localToken: config.localToken!, supervisorToken: config.supervisorToken!, incarnationId: incarnation.incarnationId!, incarnationToken: incarnation.token!, allowLoopbackHttp: true, centralFetch: async () => { throw new Error("validation cannot connect"); } });
}
export async function execute(plan: Plan, io: ExecutionIO = executionIO, env = process.env): Promise<string> {
  const { options, context } = plan;
  if (!options.apply) throw new InstallError("execution requires --apply");
  const clean = cleanEnvironment(env);
  const run = async (argv: string[], capture = false) => {
    let result;
    try { result = await io.run(argv, options.ssh ? context.code : options.code, clean, capture); } catch { throw new InstallError("command failed; output suppressed; inspect privately, do not retry automatically"); }
    if (result.code !== 0) throw new InstallError("command failed; output suppressed; inspect privately, do not retry automatically");
    return result.output;
  };
  const pinDocker = async () => {
    if (Object.keys(env).some(key => /^(COMPOSE_|COOPERATIVE_|DOCKER_)/.test(key) && env[key] !== undefined)) throw new InstallError("ambient Compose/cooperative/Docker settings refused");
    const endpoint = (await run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], true)).trim();
    if (!/^unix:\/\/\//.test(endpoint) || /[\x00-\x20\x7f]/.test(endpoint)) throw new InstallError("requires a local Unix Docker endpoint");
    clean.DOCKER_HOST = endpoint;
  };
  if (options.ssh) { await run(plan.commands[0]!.argv); return "Remote CLI exited successfully; no health verification claimed."; }
  if (options.code !== context.code) throw new InstallError("--code must name the checkout running this CLI");
  await safePath(options.code);
  await safePath(options.bun);
  await access(options.bun, constants.X_OK);
  await safePath(join(options.code, "node_modules"));
  if (options.role === "central") {
    if (Object.keys(env).some(k => /^(COMPOSE_|COOPERATIVE_|DOCKER_)/.test(k) && env[k] !== undefined)) throw new InstallError("ambient Compose/cooperative/Docker settings refused");
    await absent(options.state!);
    await absent(join(options.code, "deploy/cooperative/.env"));
    await safePath(join(options.code, "deploy/cooperative/setup.sh"));
    await pinDocker();
    for (const command of plan.commands.filter(command => command.inspect === "containers")) if ((await run(command.argv, true)).trim()) throw new InstallError("existing fleet-cooperative Docker artifacts refused");
    // Reserve both names exclusively before calling the legacy fresh-only setup.
    await mkdir(options.state!, { mode: 0o700 });
    const lock = await open(join(options.code, "deploy/cooperative/.env"), "wx", 0o600);
    try { await lock.writeFile('COOPERATIVE_STATE_DIR=' + options.state + '\nCOOPERATIVE_PORT=' + options.port + '\nCOOPERATIVE_UID=' + context.uid + '\nCOOPERATIVE_GID=' + process.getgid!() + '\nCOOPERATIVE_SUPERVISOR_HOST=' + options.hostId + '\n'); } finally { await lock.close(); }
    await run(plan.commands.at(-1)!.argv);
    return "Setup exited successfully. First local supervisor initialized; no health verification claimed.";
  }
  await validateConfig(options.role!, options.config!);
  const unit = plan.unit!;
  await absent(unit.path);
  if (options.role === "adapter" && context.platform === "linux") {
    await pinDocker();
    const probe = plan.commands.find(command => command.inspect === "containers")!;
    if ((await run(probe.argv, true)).trim()) throw new InstallError("pre-existing cooperative Docker adapter refused");
  }
  const existing = await run(plan.commands.find(command => command.inspect === "services")!.argv, true);
  if (options.role === "adapter" && context.platform === "darwin" && existing.includes("pl.raqz.fleet-cooperative-adapter")) throw new InstallError("pre-existing cooperative adapter refused");
  if (existing.split(/\r?\n/).some(line => line.split(/\s+/).includes("pl.raqz.fleet-control-" + options.role + (context.platform === "linux" ? ".service" : "")))) throw new InstallError("pre-existing service refused");
  if (context.platform === "linux") {
    const loaded = await run(["systemctl", "--user", "list-units", "--all", "--no-legend", "--no-pager", "pl.raqz.fleet-control-" + options.role + ".service"], true);
    if (loaded.includes("pl.raqz.fleet-control-" + options.role + ".service")) throw new InstallError("pre-existing loaded service refused");
  }
  await safePath(dirname(unit.path), true);
  await mkdir(dirname(unit.path), { recursive: true, mode: 0o700 });
  await safePath(dirname(unit.path));
  const file = await open(unit.path, "wx", 0o600);
  try { await file.writeFile(unit.content); } finally { await file.close(); }
  for (const command of plan.commands.filter(command => !command.inspect && command.argv[0] !== "docker")) await run(command.argv);
  return "User service registered. No health verification claimed. Failures leave artifacts for private inspection; no automatic retry.";
}
export async function doctor(plan: Plan): Promise<string> {
  const checks = [plan.options.code, plan.options.bun, join(plan.options.code, "node_modules"), join(plan.options.code, "deploy/cooperative/setup.sh")];
  for (const path of checks) await safePath(path);
  await access(plan.options.bun, constants.X_OK);
  return "Prepared local paths present. Bun " + Bun.version + ". Runtime credentials, Docker and service-manager health not checked.";
}
