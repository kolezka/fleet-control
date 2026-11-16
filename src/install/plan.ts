import { isAbsolute, join, normalize } from "node:path";

export class InstallError extends Error {}
export type Role = "central" | "adapter" | "client" | "waker";
export type Options = { command: "doctor" | "install"; role?: Role; apply: boolean; code: string; bun: string; config?: string; state?: string; hostId?: string; port?: number; ssh?: string; sshPort?: number };
export type Context = { code: string; bun: string; home: string; platform: string; uid: number };
export type Command = { argv: string[]; inspect?: "containers" | "services" };
export type Plan = { options: Options; notes: string[]; commands: Command[]; unit?: { path: string; content: string }; context: Context };
export const prerequisites = "Requires a prepared immutable checkout with Bun dependencies already installed, and externally provisioned private adapter/client configuration. No code transfer, bootstrap, dependency installation, Tailscale, updates, restore, uninstall or automatic retry. Status/logs are omitted to avoid exposing secrets.";
const fail = (message: string): never => { throw new InstallError(message); };
export function absolute(value: string): string {
  if (!value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value) || !isAbsolute(value) || normalize(value) !== value || value === "/") fail("paths must be normalized absolute paths without control characters");
  return value;
}
export function parse(args: string[], context: Context): Options {
  const command = args[0];
  if (command !== "doctor" && command !== "install") fail("usage: doctor | install central|adapter|client|waker --plan|--apply [options]");
  let index = 1;
  const role = command === "install" ? args[index++] as Role : undefined;
  if (command === "install" && !["central", "adapter", "client", "waker"].includes(role!)) fail("invalid install role");
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (; index < args.length; index++) {
    const key = args[index]!;
    if (!["--plan", "--apply", "--code", "--bun", "--config", "--state", "--host-id", "--port", "--ssh", "--ssh-port"].includes(key)) fail("unknown argument");
    if (values.has(key) || flags.has(key)) fail("duplicate argument");
    if (key === "--plan" || key === "--apply") { flags.add(key); continue; }
    const value = args[++index];
    if (!value || value.startsWith("--") || /[\x00-\x1f\x7f]/.test(value) || !value.isWellFormed()) fail("invalid argument value");
    values.set(key, value!);
  }
  if (flags.size > 1 || command === "install" && flags.size !== 1) fail("choose exactly one of --plan or --apply");
  if (command === "doctor" && (flags.has("--apply") || [...values.keys()].some(k => !["--code", "--bun"].includes(k)))) fail("doctor accepts only --code, --bun and --plan");
  const ssh = values.get("--ssh");
  if (ssh && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}@[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(ssh)) fail("invalid SSH user@host");
  if (ssh && (!values.has("--code") || !values.has("--bun"))) fail("SSH requires explicit prepared --code and absolute --bun paths");
  const sshPortText = values.get("--ssh-port");
  if (sshPortText !== undefined && (!ssh || !/^[1-9][0-9]{0,4}$/.test(sshPortText) || Number(sshPortText) > 65535)) fail("invalid SSH port");
  const code = absolute(values.get("--code") ?? context.code);
  const bun = absolute(values.get("--bun") ?? context.bun);
  const config = values.has("--config") ? absolute(values.get("--config")!) : undefined;
  const state = values.has("--state") ? absolute(values.get("--state")!) : undefined;
  const hostId = values.get("--host-id");
  const portText = values.get("--port");
  if (portText !== undefined && (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535)) fail("port must be an integer from 1 to 65535");
  if (command === "install") {
    if (role === "central") {
      if (!state || !/^[A-Za-z0-9/_.-]+$/.test(state) || !hostId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(hostId) || config) fail("central requires safe --state and explicit --host-id; --config is not accepted");
    } else if (!config || state || hostId) fail("adapter/client/waker require --config and do not accept --state or --host-id");
    // The waker has no listener.
    if (role === "waker" && portText !== undefined) fail("waker does not accept --port");
  }
  return { command: command as Options["command"], role, apply: flags.has("--apply"), code, bun, config, state, hostId, ssh, ...(sshPortText ? { sshPort: Number(sshPortText) } : {}), ...(role && role !== "waker" ? { port: Number(portText ?? (role === "central" ? 4881 : role === "adapter" ? 4882 : 4870)) } : {}) };
}
export const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const systemd = (text: string, exec = false) => '"' + text.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", () => exec ? "$$" : "$") + '"';
export function plan(options: Options, context: Context): Plan {
  const notes = [prerequisites];
  const commands: Command[] = [];
  const result: Plan = { options, context, notes, commands };
  if (options.ssh) {
    const args = [options.bun, "--no-env-file", join(options.code, "fleet-control.ts"), "install", options.role!, options.apply ? "--apply" : "--plan", "--code", options.code, "--bun", options.bun, ...(options.port ? ["--port", String(options.port)] : [])];
    if (options.config) args.push("--config", options.config);
    if (options.state) args.push("--state", options.state, "--host-id", options.hostId!);
    commands.push({ argv: ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", ...(options.sshPort ? ["-p", String(options.sshPort)] : []), "--", options.ssh, args.map(shellQuote).join(" ")] });
    notes.push("Remote plan does not connect. Remote apply invokes this CLI in the explicitly prepared directory; no remote supervisor activation except fresh central setup's explicitly described first local supervisor.");
    return result;
  }
  if (options.command === "doctor") { notes.push("Read-only local prerequisite check, not a health check or deployment proof."); return result; }
  if (options.role === "central") {
    notes.push("Fresh-only: refuse any existing state, deploy/cooperative/.env or fleet-cooperative Docker project. setup.sh initializes and activates the FIRST LOCAL supervisor; never use against an existing installation. Apply may build images, fetch Docker base images/packages, and start PostgreSQL/central through the existing setup script. Docker endpoint is pinned after local-only validation.");
    commands.push({ argv: ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"] });
    commands.push({ argv: ["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=fleet-cooperative"], inspect: "containers" });
    commands.push({ argv: ["docker", "image", "ls", "-q", "fleet-cooperative-central:local"], inspect: "containers" });
    commands.push({ argv: ["docker", "network", "ls", "-q", "--filter", "label=com.docker.compose.project=fleet-cooperative"], inspect: "containers" });
    commands.push({ argv: ["docker", "volume", "ls", "-q", "--filter", "label=com.docker.compose.project=fleet-cooperative"], inspect: "containers" });
    commands.push({ argv: ["bash", join(options.code, "deploy/cooperative/setup.sh"), options.state!, String(options.port), options.hostId!] });
    return result;
  }
  if (!["darwin", "linux"].includes(context.platform)) fail("only macOS launchd and Linux systemd --user are supported");
  absolute(context.home);
  if (options.role === "adapter" && context.platform === "linux") {
    notes.push("Linux native adapter installation requires local Docker access to exclude the known fleet-cooperative Compose adapter; no unavailable/remote daemon fallback.");
    commands.push({ argv: ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"] }, { argv: ["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=fleet-cooperative", "--filter", "label=com.docker.compose.service=adapter"], inspect: "containers" });
  }
  const label = "pl.raqz.fleet-control-" + options.role;
  const environment = options.role === "adapter" ? { COOPERATIVE_ADAPTER_CONFIG_FILE: options.config!, COOPERATIVE_ADAPTER_PORT: String(options.port) }
    : options.role === "waker" ? { COOPERATIVE_WAKER_CONFIG_FILE: options.config! }
    : { FLEET_CONTROL_CLIENT_CONFIG: options.config!, PORT: String(options.port) };
  const entry = { adapter: "src/host-agent/cooperative-main.ts", waker: "src/host-agent/waker.ts", client: "client.ts" }[options.role as "adapter" | "waker" | "client"];
  const argv = [options.bun, "--no-env-file", join(options.code, entry)];
  if (options.role === "waker") notes.push("The waker starts the configured agent command whenever central has queued work for this host. Applying it means real agent runs; it needs the adapter running and the agent's own MCP configuration.");
  if (context.platform === "darwin") {
    const path = join(context.home, "Library/LaunchAgents", label + ".plist");
    const content = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>' + label + '</string><key>ProgramArguments</key><array>' + argv.map(v => '<string>' + xml(v) + '</string>').join("") + '</array><key>WorkingDirectory</key><string>' + xml(options.code) + '</string><key>EnvironmentVariables</key><dict>' + Object.entries(environment).map(([k,v]) => '<key>' + k + '</key><string>' + xml(v) + '</string>').join("") + '</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n';
    result.unit = { path, content };
    commands.push({ argv: ["launchctl", "list"], inspect: "services" }, { argv: ["launchctl", "bootstrap", "gui/" + context.uid, path] });
  } else {
    const path = join(context.home, ".config/systemd/user", label + ".service");
    const content = '[Unit]\nDescription=Fleet Control ' + options.role + '\n[Service]\nType=simple\nWorkingDirectory=' + systemd(options.code) + '\nExecStart=' + argv.map(value => systemd(value, true)).join(" ") + '\n' + Object.entries(environment).map(([k,v]) => 'Environment=' + systemd(k + "=" + v)).join("\n") + '\nRestart=no\nUMask=0077\nStandardOutput=null\nStandardError=null\n[Install]\nWantedBy=default.target\n';
    result.unit = { path, content };
    commands.push({ argv: ["systemctl", "--user", "list-unit-files", "--no-legend", "--no-pager", label + ".service"], inspect: "services" }, { argv: ["systemctl", "--user", "daemon-reload"] }, { argv: ["systemctl", "--user", "enable", "--now", label + ".service"] });
  }
  notes.push("New exclusive user service only, no overwrite/restart/retry. Uses existing private config; loopback only. Runtime output is discarded, not exposed by this CLI. No automatic crash restart.");
  return result;
}
