// Service options from the environment, shared by index.ts and the dev script.
import { Auth } from "./auth.ts";
import type { Peer, ServeOptions } from "./server.ts";

// FLEET_CONTROL_PEERS="me-desktop=http://100.64.0.5:4871,other=https://host:4871"
export function parsePeers(raw: string | undefined): Peer[] {
  return (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    const name = p.slice(0, i).trim();
    const url = new URL(p.slice(i + 1).trim());
    if (i < 1 || !/^https?:$/.test(url.protocol)) throw new Error(`FLEET_CONTROL_PEERS: bad entry "${p}"`);
    return { name, url: url.origin + "/" };
  });
}

export async function serveOptionsFromEnv(env = process.env): Promise<ServeOptions> {
  const file = async (p: string) => Bun.file(p).text();
  return {
    hostname: env.FLEET_CONTROL_HOST ?? "127.0.0.1",
    hostName: env.FLEET_CONTROL_HOST_NAME || undefined,
    peers: parsePeers(env.FLEET_CONTROL_PEERS),
    auth: env.FLEET_CONTROL_TOKENS ? await Auth.fromFile(env.FLEET_CONTROL_TOKENS) : undefined,
    allowedHosts: (env.FLEET_CONTROL_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
    tls: env.FLEET_CONTROL_TLS_CERT && env.FLEET_CONTROL_TLS_KEY
      ? { cert: await file(env.FLEET_CONTROL_TLS_CERT), key: await file(env.FLEET_CONTROL_TLS_KEY) }
      : undefined,
  };
}
