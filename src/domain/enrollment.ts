// Adding a host to the MacBook gateway. The gateway makes the token and keeps it; the host only ever
// gets its SHA-256 hash, inside one command the operator pastes on that host (or the gateway runs
// over SSH). Two modes: "connect" adds the hash to a host service that already runs; "fresh" clones
// the code and installs a new service. The gateway adds the host only after the host answers
// /api/whoami with the expected principal and the operator role.

export type EnrollMode = "connect" | "fresh";
export const ENROLL_MODES: readonly EnrollMode[] = ["connect", "fresh"];

export type EnrollRequest = {
  id: string; // gateway host id
  name: string; // display name
  url: string; // https origin the gateway will call
  mode: EnrollMode;
  principal: string; // the gateway's name on that host
  dir: string; // connect: the running service's folder; fresh: where the code goes
  ref?: string; // fresh: git ref to check out
  port?: number; // fresh: service port
  label?: string; // fresh: launchd label or systemd unit name
  fleet?: string; // fresh: fleet name (tmux socket fleet-<name>)
  tlsCert?: string; // fresh: tailnet certificate on that host
  tlsKey?: string;
  ssh?: string; // optional user@host to run the command over SSH
  sshPort?: number;
};

export class EnrollError extends Error {}

export const HOST_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const PRINCIPAL = /^[A-Za-z0-9._-]{1,64}$/;
export const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const FLEET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
export const SSH_TARGET = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}@[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;
export const HASH = /^[0-9a-f]{64}$/;
// A path on the other host: absolute, or under its home as ~/... . No quotes, no shell syntax.
export const HOST_PATH = /^(?:\/|~\/)[A-Za-z0-9._\/ -]{0,250}$/;
export const REPO_URL = "https://github.com/kolezka/fleet-control.git";

const fail = (m: string): never => { throw new EnrollError(m); };
const field = (v: unknown, re: RegExp, what: string) => (typeof v === "string" && re.test(v) ? v : fail(`${what} is not valid`));
const port = (v: unknown, what: string) => (Number.isSafeInteger(v) && (v as number) > 0 && (v as number) < 65536 ? (v as number) : fail(`${what} must be 1-65535`));
const path = (v: unknown, what: string) => {
  const p = field(v, HOST_PATH, what);
  if (p.split("/").some((part) => part === "..")) fail(`${what} must not contain ..`);
  return p.replace(/\/+$/, "") || "/";
};

// Checks a request from the page. Unknown keys are refused so a typo is not silently ignored.
export function checkEnrollRequest(input: unknown): EnrollRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("expected a JSON object");
  const r = input as Record<string, unknown>;
  const keys = ["id", "name", "url", "mode", "principal", "dir", "ref", "port", "label", "fleet", "tlsCert", "tlsKey", "ssh", "sshPort"];
  for (const k of Object.keys(r)) if (!keys.includes(k)) fail(`unknown field ${k}`);
  const id = field(r.id, HOST_ID, "host id");
  if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 80 || /[\x00-\x1f\x7f]/.test(r.name)) fail("name must be 1-80 printable characters");
  const url = checkHostUrl(r.url);
  if (!ENROLL_MODES.includes(r.mode as EnrollMode)) fail(`mode must be one of ${ENROLL_MODES.join(", ")}`);
  const mode = r.mode as EnrollMode;
  const out: EnrollRequest = { id, name: (r.name as string).trim(), url, mode, principal: field(r.principal, PRINCIPAL, "principal"), dir: path(r.dir, "folder") };
  if (mode === "fresh") {
    out.ref = field(r.ref, GIT_REF, "git ref");
    if (out.ref.includes("..")) fail("git ref is not valid");
    out.port = port(r.port, "port");
    out.label = field(r.label, LABEL, "service name");
    out.fleet = field(r.fleet, FLEET_NAME, "fleet name");
    out.tlsCert = path(r.tlsCert, "certificate path");
    out.tlsKey = path(r.tlsKey, "key path");
    if (new URL(url).port !== String(out.port)) fail("the URL port must be the service port");
  } else {
    for (const k of ["ref", "port", "label", "fleet", "tlsCert", "tlsKey"]) if (r[k] !== undefined) fail(`${k} is only for a fresh install`);
  }
  if (r.ssh !== undefined && r.ssh !== "") out.ssh = field(r.ssh, SSH_TARGET, "SSH target");
  if (r.sshPort !== undefined) {
    if (!out.ssh) fail("SSH port needs an SSH target");
    out.sshPort = port(r.sshPort, "SSH port");
  }
  return out;
}

// The gateway only calls verified https hosts by name, at an origin with an explicit port.
export function checkHostUrl(v: unknown): string {
  if (typeof v !== "string") fail("url must be a string");
  let u: URL;
  try { u = new URL(v as string); } catch { return fail("url is not a valid URL"); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/" || !u.port) fail("url must be https://name:port with nothing after the port");
  return u.origin;
}

// POSIX single-quote; ~/ stays outside the quotes so the host's shell expands it.
export function shellWord(s: string): string {
  if (s.startsWith("~/")) return `"$HOME"/${shellWord(s.slice(2))}`;
  return /^[A-Za-z0-9._\/=:@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

// The one command to run on the host. It carries the token hash, never the token.
export function pasteCommand(req: EnrollRequest, hash: string): string {
  if (!HASH.test(hash)) fail("hash must be 64 hex characters");
  const dir = shellWord(req.dir);
  const common = ["--principal", req.principal, "--hash", hash, "--role", "operator"];
  if (req.mode === "connect") {
    return `cd ${dir} && bun scripts/enroll.ts connect ${common.map(shellWord).join(" ")}`;
  }
  const args = [...common, "--port", String(req.port), "--label", req.label!, "--fleet", req.fleet!, "--tailnet-name", new URL(req.url).hostname, "--tls-cert", req.tlsCert!, "--tls-key", req.tlsKey!];
  return [
    `git clone --quiet ${REPO_URL} ${dir}`,
    `cd ${dir}`,
    `git checkout --quiet ${shellWord(req.ref!)}`,
    "git submodule --quiet update --init --recursive",
    "bun install --frozen-lockfile --silent",
    `bun scripts/enroll.ts fresh ${args.map(shellWord).join(" ")}`,
  ].join(" && ");
}

// What the host must answer at /api/whoami before the gateway adds it.
export function enrolledAs(answer: unknown, principal: string): string | null {
  const a = answer as { principal?: unknown; role?: unknown; auth?: unknown } | null;
  if (!a || typeof a !== "object") return "the host gave no identity answer";
  if (a.auth !== true) return "the host runs without tokens";
  if (a.principal !== principal) return `the host knows this token as ${typeof a.principal === "string" ? a.principal : "nobody"}, not ${principal}`;
  if (a.role !== "operator") return `the token has role ${String(a.role)}, not operator`;
  return null;
}
