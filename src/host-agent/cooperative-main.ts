import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createCooperativeAdapter } from "./cooperative-adapter.ts";
import { createCooperativeListener } from "./cooperative-listener.ts";

// Disposable loopback experiment only. Same-UID processes can access its credentials.
async function readPrivateJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("invalid configuration");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) throw new Error("invalid configuration");
    const bytes = new Uint8Array(64 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 64 * 1024) throw new Error("invalid configuration");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally {
    await file.close();
  }
}

function exactObject<K extends string>(value: unknown, keys: K[]): value is Record<K, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key) && typeof (value as Record<string, unknown>)[key] === "string");
}

// Shutdown must outlast the adapter deadline, or force close resets a forwarded
// request before the adapter can answer "outcome unknown".
const defaultRequestTimeoutMs = 30_000;
const shutdownMarginMs = 2_000;

export async function startCooperativeAdapter(env: Record<string, string | undefined> = process.env, requestTimeoutMs = defaultRequestTimeoutMs) {
  try {
    const path = env.COOPERATIVE_ADAPTER_CONFIG_FILE;
    if (!path) throw new Error("invalid configuration");
    const config = await readPrivateJson(path);
    const base = ["centralUrl", "localToken", "supervisorToken", "incarnationFile"] as const;
    if (!exactObject(config, [...base]) && !exactObject(config, [...base, "centralCaFile"])) throw new Error("invalid configuration");
    const central = new URL(config.centralUrl);
    if (!(["127.0.0.1", "[::1]"].includes(central.hostname))) throw new Error("invalid configuration");
    // Optional PEM CA for a self-signed loopback central. Public, so no mode rule; https only.
    const caFile = (config as { centralCaFile?: string }).centralCaFile;
    let ca: string | undefined;
    if (caFile !== undefined) {
      if (!isAbsolute(caFile) || central.protocol !== "https:") throw new Error("invalid configuration");
      ca = await Bun.file(caFile).text();
      if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error("invalid configuration");
    }
    const incarnation = await readPrivateJson(config.incarnationFile);
    if (!exactObject(incarnation, ["incarnationId", "token"])) throw new Error("invalid configuration");
    const handler = createCooperativeAdapter({
      centralUrl: config.centralUrl,
      localToken: config.localToken,
      supervisorToken: config.supervisorToken,
      incarnationId: incarnation.incarnationId,
      incarnationToken: incarnation.token,
      centralFetch: (input, init) => fetch(input, ca ? { ...init, tls: { ca } } as RequestInit : init),
      allowLoopbackHttpForTests: true,
      requestTimeoutMs,
    });
    const listener = createCooperativeListener({ handler, port: 0, shutdownTimeoutMs: requestTimeoutMs + shutdownMarginMs });
    return { url: `http://127.0.0.1:${listener.port}`, stop: listener.stop };
  } catch {
    throw new Error("cooperative adapter startup failed");
  }
}

if (import.meta.main) {
  startCooperativeAdapter().then((running) => {
    const stop = () => { void running.stop().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(JSON.stringify({ url: running.url }));
  }).catch(() => { console.error("cooperative adapter startup failed"); process.exitCode = 1; });
}
