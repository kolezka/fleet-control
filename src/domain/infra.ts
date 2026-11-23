// Host infrastructure shown on the page: TLS certificates, Tailscale Serve (read only) and other services on
// this host the operator may restart, such as the DSH web server or the cooperative central in docker compose.
import { AdminError } from "./fleet-admin.ts";

export type CertId = "lan" | "tailnet";
export type CertState = {
  id: CertId;
  path: string;
  names: string[];
  notAfter: string;
  daysLeft: number;
  // Only the tailnet certificate comes from `tailscale cert`; the LAN one is made by hand (mkcert).
  renewable: boolean;
  error?: string;
};

export type OtherServiceKind = "launchd" | "systemd" | "compose";
export type OtherService =
  | { name: string; kind: "launchd"; label: string }
  | { name: string; kind: "systemd"; unit: string }
  | { name: string; kind: "compose"; dir: string; service: string };
export type OtherServiceState = { name: string; kind: OtherServiceKind; target: string; running: boolean | null; detail: string };

export type InfraView = {
  certs: CertState[];
  // Renewed files are read at the next service start; Bun cannot swap a listener's certificate.
  renewedAt: string | null;
  serve: { text: string } | { error: string };
  services: OtherServiceState[];
};

// Renew when fewer days are left; Let's Encrypt certificates from `tailscale cert` last 90 days.
export const RENEW_BEFORE_DAYS = 30;

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const LABEL = /^[A-Za-z0-9._-]{1,128}$/;
const UNIT = /^[A-Za-z0-9@._-]{1,128}\.service$/;
const DIR = /^\/[A-Za-z0-9._\/-]{1,512}$/;
const SERVICE = /^[A-Za-z0-9._-]{1,64}$/;

// FLEET_CONTROL_OTHER_SERVICES: comma separated `name=launchd:<label>`, `name=systemd:<unit>.service` or
// `name=compose:<project dir>:<service>`. Only services named here can be restarted from the page.
export function parseOtherServices(raw: string | undefined): OtherService[] {
  const out: OtherService[] = [];
  for (const entry of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const name = entry.slice(0, eq);
    const spec = entry.slice(eq + 1);
    const bad = () => new Error(`FLEET_CONTROL_OTHER_SERVICES: ${entry} must be name=launchd:<label>, name=systemd:<unit>.service or name=compose:<dir>:<service>`);
    if (eq < 1 || !NAME.test(name)) throw bad();
    if (out.some((s) => s.name === name)) throw new Error(`FLEET_CONTROL_OTHER_SERVICES names ${name} twice`);
    const [kind, ...rest] = spec.split(":");
    if (kind === "launchd" && rest.length === 1 && LABEL.test(rest[0]!)) out.push({ name, kind, label: rest[0]! });
    else if (kind === "systemd" && rest.length === 1 && UNIT.test(rest[0]!)) out.push({ name, kind, unit: rest[0]! });
    else if (kind === "compose" && rest.length === 2 && DIR.test(rest[0]!) && !rest[0]!.split("/").includes("..") && SERVICE.test(rest[1]!)) out.push({ name, kind, dir: rest[0]!, service: rest[1]! });
    else throw bad();
  }
  return out;
}

export const serviceTarget = (s: OtherService) => (s.kind === "launchd" ? s.label : s.kind === "systemd" ? s.unit : `${s.dir} (${s.service})`);

function onlyConfirm(input: unknown, word: string, what: string): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError("invalid", "body must be an object");
  for (const k of Object.keys(input)) if (k !== "confirm") throw new AdminError("invalid", `unknown field ${k}`);
  if ((input as { confirm?: unknown }).confirm !== word) throw new AdminError("invalid", `type ${word} to confirm ${what}`);
}

export const checkRenewRequest = (input: unknown) => onlyConfirm(input, "renew", "the renewal");
export function checkServiceRestart(name: string, input: unknown, services: readonly OtherService[]): OtherService {
  const s = services.find((x) => x.name === name);
  if (!s) throw new AdminError("not_found", `no service ${name} is set up for the page on this host`);
  onlyConfirm(input, name, "the restart");
  return s;
}

export function daysLeft(notAfter: Date, now: Date): number {
  return Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000);
}
