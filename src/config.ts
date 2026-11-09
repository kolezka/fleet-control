// Service options from the environment, shared by index.ts and the dev script.
import { Auth } from "./auth.ts";
import type { ServeOptions } from "./server.ts";

export async function serveOptionsFromEnv(env = process.env): Promise<ServeOptions> {
  const file = async (p: string) => Bun.file(p).text();
  return {
    hostname: env.FLEET_CONTROL_HOST ?? "127.0.0.1",
    auth: env.FLEET_CONTROL_TOKENS ? await Auth.fromFile(env.FLEET_CONTROL_TOKENS) : undefined,
    allowedHosts: (env.FLEET_CONTROL_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
    tls: env.FLEET_CONTROL_TLS_CERT && env.FLEET_CONTROL_TLS_KEY
      ? { cert: await file(env.FLEET_CONTROL_TLS_CERT), key: await file(env.FLEET_CONTROL_TLS_KEY) }
      : undefined,
  };
}
