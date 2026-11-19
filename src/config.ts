// Service options from the environment, shared by index.ts and the dev script.
import { createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { Auth, AuthConfigError, isLoopback } from "./auth.ts";
import type { Peer, ServeOptions } from "./server.ts";

// Tailscale hands out 100.64.0.0/10 (CGNAT) and fd7a:115c:a1e0::/48. Loopback is allowed for tests.
export function isTailnetAddress(host: string): boolean {
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIP(host) === 6 && /^fd7a:115c:a1e0:/i.test(host);
}

// FLEET_CONTROL_PEERS="me-desktop=http://100.64.0.5:4871,other=https://host:4871"
// A peer is a service origin; a path is dropped, as before. Credentials in the URL and a repeated
// name used to pass silently (the second peer was unreachable from the nav); they are refused.
export function parsePeers(raw: string | undefined): Peer[] {
  const seen = new Set<string>();
  return (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const bad = (why: string) => new Error(`FLEET_CONTROL_PEERS: bad entry "${p}": ${why}`);
    const i = p.indexOf("=");
    if (i < 1) throw bad("expected name=url");
    const name = p.slice(0, i).trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw bad("name may use letters, digits, '.', '_' and '-'");
    let url: URL;
    try { url = new URL(p.slice(i + 1).trim()); } catch { throw bad("not a URL"); }
    if (!/^https?:$/.test(url.protocol)) throw bad("only http and https");
    if (url.username || url.password) throw bad("no credentials in the URL");
    if (seen.has(name)) throw bad("repeated name");
    seen.add(name);
    return { name, url: url.origin + "/" };
  });
}

// PORT unset or empty means 4871. Anything else must be 1..65535: an empty or zero port used to
// bind a random port, which no client could find.
// allowZero is for entry points whose tests ask for a random port with PORT=0.
export function portFromEnv(raw: string | undefined, fallback = 4871, allowZero = false): number {
  if (raw === undefined || raw === "") return fallback;
  if (allowZero && raw === "0") return 0;
  const range = allowZero ? "0..65535" : "1..65535";
  if (!/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > 65535) throw new Error(`PORT must be ${range}, got "${raw}"`);
  return Number(raw);
}

export async function serveOptionsFromEnv(env = process.env): Promise<ServeOptions> {
  const file = async (p: string) => Bun.file(p).text();
  return {
    hostname: env.FLEET_CONTROL_HOST ?? "127.0.0.1",
    hostName: env.FLEET_CONTROL_HOST_NAME || undefined,
    peers: parsePeers(env.FLEET_CONTROL_PEERS),
    auth: env.FLEET_CONTROL_TOKENS ? await Auth.fromFile(env.FLEET_CONTROL_TOKENS) : undefined,
    allowedHosts: (env.FLEET_CONTROL_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
    tls: await tlsFromEnv(env, file),
  };
}

// A second listener for the tailnet, next to the main one (the LAN address the DSH panel uses).
// FLEET_CONTROL_TAILNET_HOST is this machine's Tailscale IP; FLEET_CONTROL_TAILNET_NAME its MagicDNS
// name, which clients use and the certificate names. Both listeners share one store, queue and
// token set. It needs auth and its own certificate (from `tailscale cert`), so a token never
// crosses it in clear text and the name the client dials is the name the certificate holds.
export async function tailnetOptionsFromEnv(
  env: Record<string, string | undefined>,
  base: ServeOptions,
  port: number,
  file: (path: string) => Promise<string> = (p) => Bun.file(p).text(),
  now = new Date(),
  warn: (message: string) => void = (m) => console.warn(m),
): Promise<ServeOptions | undefined> {
  const host = env.FLEET_CONTROL_TAILNET_HOST;
  const name = env.FLEET_CONTROL_TAILNET_NAME;
  const certPath = env.FLEET_CONTROL_TAILNET_TLS_CERT;
  const keyPath = env.FLEET_CONTROL_TAILNET_TLS_KEY;
  if (!host && !name && !certPath && !keyPath) return undefined;
  if (!host) throw new Error("FLEET_CONTROL_TAILNET_HOST is required for the tailnet listener");
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(name ?? "")) throw new Error("FLEET_CONTROL_TAILNET_NAME must be the MagicDNS name, e.g. host.tailnet.ts.net");
  if (!base.auth) throw new Error("the tailnet listener needs FLEET_CONTROL_TOKENS");
  if (!certPath || !keyPath) throw new Error("the tailnet listener needs FLEET_CONTROL_TAILNET_TLS_CERT and FLEET_CONTROL_TAILNET_TLS_KEY");
  const tls = await tlsFromEnv({ FLEET_CONTROL_TLS_CERT: certPath, FLEET_CONTROL_TLS_KEY: keyPath }, file, now, warn);
  const x509 = new X509Certificate(tls!.cert);
  if (!x509.checkHost(name!)) throw new Error(`FLEET_CONTROL_TAILNET_TLS_CERT does not name ${name}`);
  if (host === base.hostname) throw new Error("FLEET_CONTROL_TAILNET_HOST must differ from FLEET_CONTROL_HOST");
  if (!isTailnetAddress(host) && !isLoopback(host)) throw new Error("FLEET_CONTROL_TAILNET_HOST must be a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48)");
  if (!Number.isSafeInteger(port) || port < 1) throw new Error("the tailnet listener needs a fixed PORT");
  return { ...base, hostname: host, tls, allowedHosts: [...(base.allowedHosts ?? []), `${name}:${port}`] };
}

// SIGHUP rereads FLEET_CONTROL_TOKENS. Requests check the token each time, so a revoked token stops
// working at once; the server also closes terminal sockets opened with a revoked or rotated token.
export async function reloadTokens(auth: Auth, path: string, log: (line: string) => void = console.log): Promise<boolean> {
  try {
    auth.replace(await Auth.fromFile(path));
    log(`tokens reloaded: ${auth.names().length} principal(s)`);
    return true;
  } catch (error) {
    const why = error instanceof AuthConfigError ? error.message : "file could not be read";
    log(`tokens reload refused, previous tokens kept: ${why}`);
    return false;
  }
}

export function reloadTokensOnHangup(auth: Auth | undefined, env = process.env): void {
  const path = env.FLEET_CONTROL_TOKENS;
  if (!auth || !path) return;
  process.on("SIGHUP", () => void reloadTokens(auth, path));
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const CERT_WARN_DAYS = 30;

// Only one of the two paths set used to start plain HTTP silently. Now it refuses, as does an
// expired or not yet valid certificate, or a key that does not match. Near expiry it warns.
export async function tlsFromEnv(
  env: Record<string, string | undefined>,
  file: (path: string) => Promise<string>,
  now = new Date(),
  warn: (message: string) => void = (m) => console.warn(m),
): Promise<{ cert: string; key: string } | undefined> {
  const certPath = env.FLEET_CONTROL_TLS_CERT;
  const keyPath = env.FLEET_CONTROL_TLS_KEY;
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath) throw new Error("FLEET_CONTROL_TLS_CERT and FLEET_CONTROL_TLS_KEY must be set together");
  const [cert, key] = await Promise.all([file(certPath), file(keyPath)]);
  let x509: X509Certificate;
  try { x509 = new X509Certificate(cert); } catch { throw new Error("FLEET_CONTROL_TLS_CERT is not a PEM certificate"); }
  let privateKey;
  try { privateKey = createPrivateKey(key); } catch { throw new Error("FLEET_CONTROL_TLS_KEY is not a PEM private key"); }
  if (!x509.checkPrivateKey(privateKey)) throw new Error("FLEET_CONTROL_TLS_KEY does not match FLEET_CONTROL_TLS_CERT");
  const from = new Date(x509.validFrom);
  const to = new Date(x509.validTo);
  if (now < from) throw new Error(`TLS certificate is not valid until ${from.toISOString()}`);
  if (now >= to) throw new Error(`TLS certificate expired at ${to.toISOString()}`);
  const days = Math.floor((to.getTime() - now.getTime()) / DAY_MS);
  if (days < CERT_WARN_DAYS) warn(`TLS certificate expires in ${days} days (${to.toISOString()}); make a new one`);
  return { cert, key };
}
