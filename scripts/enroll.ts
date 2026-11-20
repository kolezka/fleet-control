// Runs on a host to let the MacBook gateway in. The gateway shows this command; it carries only the
// SHA-256 hash of the gateway's token, never the token.
//
//   bun scripts/enroll.ts connect --principal <name> --hash <hex> --role operator
//     Run in the folder of a host service that already runs (launchd or systemd --user). Adds the
//     hash to that service's tokens file and sends it SIGHUP. Pasting it twice changes nothing.
//
//   bun scripts/enroll.ts fresh --principal <name> --hash <hex> --role operator --port <n> --label <name>
//       --fleet <name> --tailnet-name <magicdns> --tls-cert <file> --tls-key <file>
//     Run in a fresh checkout. Makes an empty test fleet with its own tmux socket, a tokens file
//     with only this hash, and a launchd or systemd --user service on 127.0.0.1:<port> and the
//     Tailscale address :<port>. Refuses if any of those already exist.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthConfigError } from "../src/auth.ts";
import { FLEET_NAME, HASH, LABEL, PRINCIPAL } from "../src/domain/enrollment.ts";
import { addHash, withLock, writeAtomic } from "./tokens.ts";

export class EnrollFailure extends Error {}
const fail = (m: string): never => { throw new EnrollFailure(m); };

export type Service = { label: string; dir: string; tokens?: string; pid?: number };

// The one running service whose folder is this folder. None or several is an error, not a guess.
export function pickService(services: Service[], cwd: string): Service & { tokens: string; pid: number } {
  const here = services.filter((s) => s.dir === cwd);
  if (here.length === 0) fail(`no running Fleet Control service has its folder at ${cwd}; run this in the service's folder, or use fresh`);
  if (here.length > 1) fail(`several services use ${cwd}: ${here.map((s) => s.label).join(", ")}`);
  const s = here[0]!;
  if (!s.tokens) fail(`service ${s.label} has no FLEET_CONTROL_TOKENS; it runs without tokens and cannot take a gateway`);
  if (!s.pid) fail(`service ${s.label} is not running`);
  return s as Service & { tokens: string; pid: number };
}

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

// launchd: LaunchAgents whose WorkingDirectory is set; systemd --user: loaded service units.
export function listServices(platform = process.platform, home = homedir()): Service[] {
  const out: Service[] = [];
  if (platform === "darwin") {
    const dir = join(home, "Library/LaunchAgents");
    for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".plist")) : []) {
      const j = run("plutil", ["-convert", "json", "-o", "-", join(dir, file)]);
      if (!j.ok) continue;
      let p: { Label?: string; WorkingDirectory?: string; EnvironmentVariables?: Record<string, string> };
      try { p = JSON.parse(j.out); } catch { continue; }
      if (!p.Label || !p.WorkingDirectory) continue;
      const print = run("launchctl", ["print", `gui/${process.getuid!()}/${p.Label}`]);
      const pid = Number(/^\s*pid = (\d+)$/m.exec(print.out)?.[1] ?? NaN);
      out.push({ label: p.Label, dir: real(p.WorkingDirectory), tokens: p.EnvironmentVariables?.FLEET_CONTROL_TOKENS, pid: Number.isSafeInteger(pid) ? pid : undefined });
    }
  } else if (platform === "linux") {
    const units = run("systemctl", ["--user", "list-units", "--type=service", "--state=running", "--no-legend", "--plain"]);
    for (const line of units.out.split("\n")) {
      const unit = line.trim().split(/\s+/)[0];
      if (!unit?.endsWith(".service")) continue;
      const show = run("systemctl", ["--user", "show", unit, "-p", "WorkingDirectory", "-p", "MainPID", "-p", "Environment"]);
      const prop = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(show.out)?.[1] ?? "";
      if (!prop("WorkingDirectory")) continue;
      const tokens = prop("Environment").split(" ").find((e) => e.startsWith("FLEET_CONTROL_TOKENS="))?.slice("FLEET_CONTROL_TOKENS=".length);
      const pid = Number(prop("MainPID"));
      out.push({ label: unit, dir: real(prop("WorkingDirectory")), tokens, pid: pid > 0 ? pid : undefined });
    }
  } else fail("only macOS launchd and Linux systemd --user services are supported");
  return out;
}

export type Args = Record<string, string>;
export function parseArgs(argv: string[], allowed: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!, v = argv[i + 1];
    if (v === undefined) fail(`${k} needs a value`);
    if (!k.startsWith("--") || !allowed.includes(k.slice(2))) fail(`unknown argument ${k}`);
    if (v === undefined || v.startsWith("--")) fail(`${k} needs a value`);
    if (k.slice(2) in a) fail(`${k} given twice`);
    a[k.slice(2)] = v!;
  }
  for (const k of allowed) if (!(k in a)) fail(`--${k} is required`);
  if (!PRINCIPAL.test(a.principal!)) fail("principal is not valid");
  if (!HASH.test(a.hash!)) fail("hash must be 64 lowercase hex characters");
  if (a.role !== "operator") fail("role must be operator");
  return a;
}

// Adds the line under the tokens lock and asks the service to reread it.
export function connect(a: Args, service: { tokens: string; pid: number }, signal: (pid: number) => void = (pid) => process.kill(pid, "SIGHUP")): string {
  const changed = withLock(service.tokens, () => {
    const next = addHash(readFileSync(service.tokens, "utf8"), a.principal!, a.hash!, "operator");
    if (next.changed) writeAtomic(service.tokens, next.text);
    return next.changed;
  });
  signal(service.pid);
  return changed ? `Added ${a.principal} (operator) to ${service.tokens} and sent SIGHUP to ${service.pid}.`
    : `${a.principal} was already there with this hash; sent SIGHUP to ${service.pid} again.`;
}

export type FreshPlan = { files: { path: string; content: string; mode: number }[]; dirs: string[]; commands: string[][]; unit: string; certs: string[] };

// Pure: everything a fresh install writes and runs. Paths come from the label, so two installs differ.
export function freshPlan(a: Args, ctx: { code: string; bun: string; home: string; platform: string; uid: number; tailnetIp: string }): FreshPlan {
  if (!LABEL.test(a.label!)) fail("label is not valid");
  if (!FLEET_NAME.test(a.fleet!)) fail("fleet name is not valid");
  const port = Number(a.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail("port must be 1-65535");
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(a["tailnet-name"]!)) fail("tailnet name is not valid");
  const expand = (p: string) => (p.startsWith("~/") ? join(ctx.home, p.slice(2)) : p);
  const data = join(ctx.home, ".local/share/fleet-control", a.label!);
  const conf = join(ctx.home, ".config/fleet-control", a.label!);
  const fleetConf = join(data, "fleet.conf");
  const tokens = join(conf, "tokens");
  const path = [dirname(ctx.bun), join(ctx.home, ".local/bin"), ...(ctx.platform === "darwin" ? ["/opt/homebrew/bin"] : []), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const env: Record<string, string> = {
    PATH: path,
    FLEET_CONF: fleetConf,
    FLEET_CONTROL_DB: join(data, "state.db"),
    FLEET_CONTROL_HOST: "127.0.0.1",
    FLEET_CONTROL_HOST_NAME: a.label!,
    PORT: String(port),
    FLEET_CONTROL_TOKENS: tokens,
    FLEET_CONTROL_TAILNET_HOST: ctx.tailnetIp,
    FLEET_CONTROL_TAILNET_NAME: a["tailnet-name"]!,
    FLEET_CONTROL_TAILNET_TLS_CERT: expand(a["tls-cert"]!),
    FLEET_CONTROL_TAILNET_TLS_KEY: expand(a["tls-key"]!),
  };
  const files = [
    { path: fleetConf, content: `FLEET=${a.fleet}\nFLEET_DIR=${data}\nAGENTS=()\n`, mode: 0o644 },
    { path: tokens, content: `${a.principal} ${a.hash} operator\n`, mode: 0o600 },
  ];
  const commands: string[][] = [["env", `FLEET_CONF=${fleetConf}`, join(ctx.code, "vendor/agent-fleet/scripts/fleet"), "sync"]];
  let unit: string;
  if (ctx.platform === "darwin") {
    unit = join(ctx.home, "Library/LaunchAgents", `${a.label}.plist`);
    const x = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const log = join(ctx.home, "Library/Logs", `${a.label}.log`);
    files.push({ path: unit, mode: 0o644, content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${x(a.label!)}</string><key>ProgramArguments</key><array><string>${x(ctx.bun)}</string><string>index.ts</string></array><key>WorkingDirectory</key><string>${x(ctx.code)}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${x(v)}</string>`).join("")}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${x(log)}</string><key>StandardErrorPath</key><string>${x(log)}</string></dict></plist>\n` });
    commands.push(["launchctl", "bootstrap", `gui/${ctx.uid}`, unit]);
  } else if (ctx.platform === "linux") {
    unit = join(ctx.home, ".config/systemd/user", `${a.label}.service`);
    const q = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
    files.push({ path: unit, mode: 0o644, content: `[Unit]\nDescription=Fleet Control host service ${a.label} (added from the gateway)\nAfter=network-online.target tailscaled.service\n\n[Service]\nType=simple\nWorkingDirectory=${q(ctx.code)}\n${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join("\n")}\nUnsetEnvironment=NO_COLOR\nExecStart=${q(ctx.bun)} index.ts\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n` });
    commands.push(["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", `${a.label}.service`]);
  } else return fail("only macOS launchd and Linux systemd --user services are supported");
  return { files, dirs: [data, conf], commands, unit, certs: [env.FLEET_CONTROL_TAILNET_TLS_CERT!, env.FLEET_CONTROL_TAILNET_TLS_KEY!] };
}

// Refuses before writing anything if this label, folder or certificate is not right.
export function checkFresh(p: FreshPlan, a: Args, exists = existsSync, readable = (f: string) => { try { readFileSync(f); return true; } catch { return false; } }) {
  for (const d of p.dirs) if (exists(d)) fail(`${d} already exists; choose another service name`);
  if (exists(p.unit)) fail(`${p.unit} already exists; choose another service name`);
  for (const f of p.certs) {
    if (!readable(f)) fail(`cannot read ${f}; make it first, for example: sudo tailscale cert --cert-file <cert> --key-file <key> ${a["tailnet-name"]}, then chown it to this user`);
  }
}

function tailnetIp(): string {
  const r = run("tailscale", ["ip", "-4"]);
  const ip = r.out.trim().split("\n")[0] ?? "";
  if (!r.ok || !/^100\.\d+\.\d+\.\d+$/.test(ip)) fail("cannot read this machine's Tailscale address (tailscale ip -4)");
  return ip;
}

async function waitUp(port: number): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/whoami`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 401) return true;
    } catch {}
    await Bun.sleep(500);
  }
  return false;
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    if (mode === "connect") {
      const a = parseArgs(rest, ["principal", "hash", "role"]);
      console.log(connect(a, pickService(listServices(), real(process.cwd()))));
      console.log("Now press Check in the gateway.");
    } else if (mode === "fresh") {
      const a = parseArgs(rest, ["principal", "hash", "role", "port", "label", "fleet", "tailnet-name", "tls-cert", "tls-key"]);
      const code = real(process.cwd());
      if (!existsSync(join(code, "index.ts")) || !existsSync(join(code, "vendor/agent-fleet/scripts/fleet"))) fail("run this in a Fleet Control checkout with its submodule");
      const p = freshPlan(a, { code, bun: process.execPath, home: homedir(), platform: process.platform, uid: process.getuid!(), tailnetIp: tailnetIp() });
      checkFresh(p, a);
      for (const d of p.dirs) mkdirSync(d, { recursive: true, mode: 0o700 });
      for (const f of p.files) {
        mkdirSync(dirname(f.path), { recursive: true });
        writeFileSync(f.path, f.content, { mode: f.mode, flag: "wx" });
      }
      for (const c of p.commands) {
        const r = run(c[0]!, c.slice(1));
        if (!r.ok) fail(`${c.join(" ")} failed: ${r.err.trim() || r.out.trim()}`);
      }
      const up = await waitUp(Number(a.port));
      console.log(up ? `Service ${a.label} runs on port ${a.port}. Now press Check in the gateway.` : `Service ${a.label} was installed but does not answer on 127.0.0.1:${a.port}; see its log.`);
      if (!up) process.exit(1);
    } else {
      console.error("usage: bun scripts/enroll.ts connect|fresh --principal <name> --hash <hex> --role operator [...]");
      process.exit(2);
    }
  } catch (e) {
    console.error(e instanceof EnrollFailure || e instanceof AuthConfigError ? `refused: ${e.message}` : `failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
