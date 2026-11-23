// Host service. Requires FLEET_CONF. Loopback without auth by default; set FLEET_CONTROL_HOST
// to another address only together with FLEET_CONTROL_TOKENS (see docs/installation.md).
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { agentSettingsFromEnv, fileRootsFromEnv, portFromEnv, reloadTokensOnHangup, serveOptionsFromEnv, tailnetOptionsFromEnv } from "./src/config.ts";
import { agentUseCases } from "./src/application/agents.ts";
import { Agents } from "./src/data/agents.ts";
import { FleetAgentLauncher } from "./src/fleet/agents.ts";
import { FileAgentTokens } from "./src/agent-tokens.ts";
import { Commands } from "./src/data/commands.ts";
import { Deliverer } from "./src/application/delivery.ts";
import { fleetSender } from "./src/fleet/sender.ts";
import { FleetCli } from "./src/fleet/cli.ts";
import { resolveFleetBin } from "./src/fleet/path.ts";
import { Requests } from "./src/data/requests.ts";
import { observerForConf } from "./src/observe/claude.ts";
import { serve, ViewerSlots } from "./src/server.ts";
import { Store } from "./src/data/store.ts";
import { Leases } from "./src/data/leases.ts";
import { leaseUseCases } from "./src/application/leases.ts";
import { findTmux, fleetSocket, tmuxLeaseTerminal } from "./src/fleet/lease-terminal.ts";
import { FleetAdminHost, serviceLogFromEnv } from "./src/fleet/admin.ts";
import { findBash, managerOf, WatchdogService } from "./src/fleet/watchdog-service.ts";
import { findTailscale, HostInfra, type CertFiles } from "./src/fleet/infra.ts";
import { infraUseCases } from "./src/application/infra.ts";
import { parseOtherServices } from "./src/domain/infra.ts";
import { keepsFleetRow } from "./src/domain/agents.ts";
import type { MoveTarget } from "./src/domain/move.ts";
import { SessionStarts } from "./src/data/session-starts.ts";
import { HostTokenFile } from "./src/token-file.ts";
import { HostSettingsFile, settingsPath } from "./src/settings-file.ts";
import { DiskFiles } from "./src/fleet/files.ts";
import { parseSettingsFile, settingsRevision } from "./src/application/settings.ts";
import { settingsEnv, settingsOf } from "./src/domain/settings.ts";
import { detectManager, HostUpdates, urlHost } from "./src/update-host.ts";


// Settings saved from the page (a JSON file beside the tokens file) override the plist's or unit's values.
// Only with fleet administration on: that is where the page shows and edits them. A file that does not load,
// or that the start below could not use, is skipped with a message, so a bad save never keeps the page down.
const baseEnv: Record<string, string | undefined> = { ...process.env };
const settingsFile = process.env.FLEET_CONTROL_ADMIN === "1"
  ? (() => { try { return settingsPath(baseEnv); } catch (e) { console.error(`${e instanceof Error ? e.message : e}`); process.exit(1); } })()
  : null;
// The checks a start runs on these settings, beyond parsing: managed agents' values, and a fleet that terminal
// input can use. A save from the page runs them too.
// Input is checked only when the file turns it on: the plist's own input is checked by the start below.
const startCheck = async (next: Record<string, string | undefined>) => {
  agentSettingsFromEnv(next);
  // A fleet.conf named by Move fleet must still be there; the plist's own is checked by the start itself.
  if (next.FLEET_CONF && next.FLEET_CONF !== baseEnv.FLEET_CONF && !existsSync(next.FLEET_CONF)) throw new Error(`${next.FLEET_CONF} does not exist`);
  if (next.FLEET_CONTROL_INPUT === "1" && (baseEnv.FLEET_CONTROL_INPUT !== "1" || next.FLEET_CONF !== baseEnv.FLEET_CONF)) { await fleetSocket(next.FLEET_CONF!); findTmux(); }
};
let env = baseEnv;
let settingsSkipped: { reason: string; revision: string } | null = null;
if (settingsFile) {
  let text: string | null = null;
  try {
    text = HostSettingsFile.readSync(settingsFile);
    if (text !== null) {
      const next = settingsEnv(baseEnv, parseSettingsFile(text));
      await startCheck(next);
      env = next;
      console.log(`settings from ${settingsFile}`);
    }
  } catch (e) {
    // A file that could not even be read gets no revision any file can have, so its reason never shows for another.
    settingsSkipped = { reason: e instanceof Error ? e.message : String(e), revision: text === null ? "unreadable" : settingsRevision(text) };
    console.error(`settings file ${settingsFile} skipped: ${settingsSkipped.reason}`);
  }
}
// After the settings file: Move fleet keeps the moved fleet.conf there.
const confPath = env.FLEET_CONF;
if (!confPath) {
  console.error("FLEET_CONF is required (path to an agent-fleet fleet.conf)");
  process.exit(1);
}
// What this start runs, beside the settings file: Move fleet reads it to know the restart took the new fleet.conf.
if (settingsFile) {
  try { writeFileSync(`${settingsFile}.running`, `${JSON.stringify({ pid: process.pid, fleetConf: resolve(confPath), startedAt: new Date().toISOString() })}\n`, { mode: 0o600 }); } catch (e) {
    console.error(`could not write ${settingsFile}.running: ${e instanceof Error ? e.message : e}`);
  }
}
const fleetBin = resolveFleetBin();
const observed = await observerForConf(confPath);
if ("disabled" in observed) console.warn(`model observation off: ${observed.disabled}`);
const observer = "disabled" in observed ? undefined : observed;
const store = new Store(process.env.FLEET_CONTROL_DB ?? ":memory:");
const commands = new Commands(store.db);
const unknown = commands.reconcileAfterRestart();
if (unknown.length) console.warn(`delivery outcome unknown after restart: ${unknown.join(", ")}`);
const options = await serveOptionsFromEnv();
const port = portFromEnv(process.env.PORT);
// Checked before anything binds, so a bad tailnet setting does not leave a half-started service.
const tailnet = await tailnetOptionsFromEnv(process.env, options, port);
reloadTokensOnHangup(options.auth);
const agentSettings = agentSettingsFromEnv(env);
// Without tokens anyone on the machine could start an unattended agent, so managed agents need them even on loopback.
if (agentSettings && !options.auth) {
  console.error("FLEET_CONTROL_AGENT_ROOTS needs FLEET_CONTROL_TOKENS");
  process.exit(1);
}
// FLEET_CONTROL_INPUT=1 lets an operator token type into a session through an input lease.
// A setup error (no tmux, a remote fleet) stops the start with a plain line, not a stack.
const leaseTerminal = async () => {
  try { return tmuxLeaseTerminal(await fleetSocket(confPath)); } catch (e) {
    console.error(`FLEET_CONTROL_INPUT: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
};
const input = env.FLEET_CONTROL_INPUT === "1"
  ? leaseUseCases({ leases: new Leases(store.db), terminal: await leaseTerminal() })
  : undefined;
if (input && !options.auth) {
  console.error("FLEET_CONTROL_INPUT needs FLEET_CONTROL_TOKENS");
  process.exit(1);
}
// While a session has a live input lease its queued commands wait, and go out when the lease ends.
const deliverer = new Deliverer(commands, fleetSender(fleetBin, confPath), undefined, async (session) => (input ? (await input.holds(session)) !== null : false));
input?.onEnd((lease) => { deliverer.deliverQueued(lease.session).catch((e) => console.error(`held deliveries failed: ${e instanceof Error ? e.message : e}`)); });
// A restart dropped every socket, so no lease from before it can still have its writer.
if (input) {
  const ended = input.endAfterRestart();
  if (ended.length) console.log(`input leases ended by the restart: ${ended.join(", ")}`);
}
// FLEET_CONTROL_ADMIN=1 lets an operator edit fleet.conf, read the logs and restart a session from the page.
// FLEET_CONTROL_SERVICE_LOG names this service's own log: a file, or journal:<unit> for systemd.
const adminSetup = () => {
  try {
    return { host: new FleetAdminHost({ confPath, fleetBin, serviceLog: serviceLogFromEnv(process.env.FLEET_CONTROL_SERVICE_LOG), tmuxBin: findTmux() }), starts: new SessionStarts(store.db) };
  } catch (e) {
    console.error(`FLEET_CONTROL_ADMIN: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
};
const admin = process.env.FLEET_CONTROL_ADMIN === "1" ? adminSetup() : undefined;
if (admin && !options.auth) {
  console.error("FLEET_CONTROL_ADMIN needs FLEET_CONTROL_TOKENS");
  process.exit(1);
}
// FLEET_CONTROL_FILE_ROOTS (":"-separated) names the folders the page's file editor may open; unset means the
// fleet folder and the agent folders. Never the tokens folder, the settings file or fleet.conf, which has its own editor.
const filesSetup = () => {
  try {
    const roots = fileRootsFromEnv(env, [dirname(confPath), ...(agentSettings?.roots ?? [])]);
    const tokensDir = dirname(process.env.FLEET_CONTROL_TOKENS!);
    const protectedPaths = [tokensDir, confPath, join(dirname(confPath), "fleet-control-agents.conf"), ...(settingsFile ? [settingsFile] : [])];
    return { host: new DiskFiles(), roots, protectedPaths };
  } catch (e) {
    console.error(`FLEET_CONTROL_FILE_ROOTS: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
};
// With fleet administration on, an operator also restarts this service and updates it to a release from the
// page. A separate updater process does it (scripts/updater.ts); its job files and backups go beside the tokens.
// The infrastructure part: the service's own certificates, Tailscale Serve (read only), and the services named
// in FLEET_CONTROL_OTHER_SERVICES, which an operator may restart from the page.
const infraSetup = async () => {
  let services;
  try { services = parseOtherServices(env.FLEET_CONTROL_OTHER_SERVICES); } catch (e) { console.error(`${e instanceof Error ? e.message : e}`); process.exit(1); }
  const certs: CertFiles[] = [];
  if (env.FLEET_CONTROL_TLS_CERT && env.FLEET_CONTROL_TLS_KEY) certs.push({ id: "lan", cert: env.FLEET_CONTROL_TLS_CERT, key: env.FLEET_CONTROL_TLS_KEY });
  if (env.FLEET_CONTROL_TAILNET_TLS_CERT && env.FLEET_CONTROL_TAILNET_TLS_KEY) certs.push({ id: "tailnet", cert: env.FLEET_CONTROL_TAILNET_TLS_CERT, key: env.FLEET_CONTROL_TAILNET_TLS_KEY, name: env.FLEET_CONTROL_TAILNET_NAME });
  return { host: new HostInfra({ certs, tailscale: await findTailscale(), uid: process.getuid?.() ?? 0 }), services };
};
const updatesSetup = () => {
  const home = process.env.HOME ?? "";
  const tokens = process.env.FLEET_CONTROL_TOKENS!;
  const manager = detectManager(process.env, home);
  const fleetDir = dirname(confPath);
  const files = [tokens, confPath, join(fleetDir, "watchdog.sh"), join(fleetDir, "fleet-control-agents.conf")];
  if (settingsFile) files.push(settingsFile);
  if (manager?.kind === "launchd") files.push(manager.plist);
  if (manager?.kind === "systemd" && manager.unitFile) files.push(manager.unitFile);
  const db = process.env.FLEET_CONTROL_DB && process.env.FLEET_CONTROL_DB !== ":memory:" ? resolve(process.env.FLEET_CONTROL_DB) : null;
  return {
    host: new HostUpdates({
      dir: process.cwd(), manager, db, files, fleetConf: resolve(confPath),
      rollbackRoot: dirname(resolve(tokens)), jobDir: join(dirname(resolve(tokens)), "updates"),
      health: `${options.tls ? "https" : "http"}://${urlHost(options.hostname ?? "127.0.0.1")}:${port}`,
      env: baseEnv,
    }),
  };
};
const updates = admin && options.auth ? updatesSetup() : null;
const watchdogService = admin ? new WatchdogService({ manager: managerOf(process.platform, process.env), home: homedir(), uid: process.getuid?.() ?? 0, bash: await findBash(), path: process.env.PATH ?? "/usr/bin:/bin", tmuxBin: findTmux() }) : null;
const agentStore = agentSettings ? new Agents(store.db) : null;
const leaseStore = input ? new Leases(store.db) : null;
// Move fleet: needs the updater (it restarts the service) and the settings file (it keeps the new fleet.conf).
const move = admin && updates
  ? {
    host: admin.host,
    watchdog: watchdogService,
    agents: () => (agentStore?.list() ?? []).filter((a) => keepsFleetRow(a.state)).map((a) => a.name),
    leases: () => (leaseStore?.openAll() ?? []).map((l) => l.session),
    targetUsed: async (dir: string) => { try { return readdirSync(dir).length > 0; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ENOENT"; } },
    settingsFile,
    unavailable: () => updates.host.unavailable(),
    start: (m: { from: MoveTarget; to: MoveTarget; settingsFile: string }, by: string) => updates.host.start("move", null, by, m),
  }
  : undefined;
// One set of dependencies: both listeners share the store, the queue, the one delivery at a time and the tokens.
const deps = {
  fleet: new FleetCli({ fleetBin, confPath }),
  store,
  observer,
  terminal: { fleetBin, confPath },
  control: { commands, deliverer, requests: new Requests(store.db) },
  input,
  admin,
  // With fleet administration on, an operator also lists, rotates and revokes tokens from the page.
  tokens: admin && options.auth ? { file: new HostTokenFile(process.env.FLEET_CONTROL_TOKENS!, options.auth) } : undefined,
  // With fleet administration on, an operator also runs agent-fleet's watchdog as a launchd or systemd service.
  watchdog: admin
    ? {
      host: admin.host,
      watchdog: watchdogService!,
    }
    : undefined,
  // With fleet administration on, an operator also edits text files in the allowed folders.
  files: admin && options.auth ? filesSetup() : undefined,
  // With fleet administration on, an operator also edits the service settings; they apply at the next start.
  settings: admin && settingsFile
    ? {
      file: new HostSettingsFile(settingsFile),
      baseEnv,
      running: settingsOf(env),
      skipped: settingsSkipped,
      check: startCheck,
    }
    : undefined,
  updates: updates ?? undefined,
  infra: admin && options.auth ? await infraSetup() : undefined,
  move,
  agents: agentSettings
    ? {
      agents: agentStore!,
      launcher: new FleetAgentLauncher({ fleetBin, confPath, roots: agentSettings.roots, mcpUrl: agentSettings.mcpUrl }),
      models: agentSettings.models,
      // Orchestrators get their own agent-role line in the tokens file; offered only with an MCP URL.
      tokens: agentSettings.mcpUrl ? new FileAgentTokens(process.env.FLEET_CONTROL_TOKENS!, options.auth!) : undefined,
    }
    : undefined,
};
if (deps.agents) {
  const offered = Object.entries(agentSettings!.models).map(([k, m]) => `${k}: ${m.join(", ")}`).join("; ");
  console.log(`managed agents in ${agentSettings!.roots.join(", ")} (${offered})${agentSettings!.mcpUrl ? `; orchestrators use ${agentSettings!.mcpUrl}` : ""}`);
  // A restart cut off any start or stop in progress; settle those rows before serving.
  try {
    const settled = await agentUseCases(deps.agents).recover();
    if (settled.length) console.log(`settled managed agents after restart: ${settled.join(", ")}`);
  } catch (e) {
    console.error(`managed agents could not be settled: ${e instanceof Error ? e.message : e}`);
  }
}
// One cap on terminal PTYs for the whole process, whichever listener the socket came in on.
const viewerSlots = new ViewerSlots();
const server = serve(deps, port, { ...options, viewerSlots });
if (tailnet) {
  try {
    const second = serve(deps, server.port, { ...tailnet, viewerSlots });
    console.log(`Fleet Control tailnet listener on ${second.url} as https://${process.env.FLEET_CONTROL_TAILNET_NAME}:${second.port}/`);
  } catch (e) {
    // Half a service looks up to a supervisor; stop the LAN listener and fail the start instead.
    server.stop(true);
    console.error(`tailnet listener failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
if (deps.infra) {
  // Once at start and then daily: renew the tailnet certificate when it nears its end.
  const due = () => infraUseCases(deps.infra!).renewIfDue().catch((e) => console.error(`certificate check failed: ${e instanceof Error ? e.message : e}`));
  void due();
  setInterval(due, 24 * 3600_000).unref();
}
if (admin) console.log(`fleet administration on: fleet.conf ${confPath}, service log ${process.env.FLEET_CONTROL_SERVICE_LOG?.trim() || "not set"}`);
console.log(`Fleet Control service on ${server.url} (MCP at ${server.url}mcp)`);
