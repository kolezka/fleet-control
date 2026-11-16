import { X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createCooperativeAdapter } from "./cooperative-adapter.ts";
import { createCooperativeListener } from "./cooperative-listener.ts";

// Loopback listener for a trusted host. Same-UID processes can access its credentials.
export async function readPrivateJson(path: string): Promise<unknown> {
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

// A CA is public, so no owner or mode rule, but it must be a small regular file and not a symlink.
async function readPublicPem(path: string): Promise<string> {
  const limit = 64 * 1024;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("invalid configuration");
    const bytes = new Uint8Array(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("invalid configuration");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
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
  // Each step names a fixed reason. Messages never carry file content, paths or tokens.
  let reason = "invalid configuration";
  const step = async <T>(label: string, run: () => T | Promise<T>): Promise<T> => { reason = label; return run(); };
  try {
    const path = await step("COOPERATIVE_ADAPTER_CONFIG_FILE must be an absolute path", () => {
      const value = env.COOPERATIVE_ADAPTER_CONFIG_FILE;
      if (!value || !isAbsolute(value)) throw new Error("invalid configuration");
      return value;
    });
    const config = await step("adapter config file is missing, a symlink, not owned by this user, not mode 0600, too large or not JSON", () => readPrivateJson(path));
    const base = ["centralUrl", "localToken", "supervisorToken", "incarnationFile"] as const;
    const central = await step("adapter config needs exactly centralUrl, localToken, supervisorToken, incarnationFile and optional centralCaFile, all strings", () => {
      if (!exactObject(config, [...base]) && !exactObject(config, [...base, "centralCaFile"])) throw new Error("invalid configuration");
      return config;
    });
    const centralUrl = await step("centralUrl must be https, or http on 127.0.0.1 or [::1]", () => {
      const url = new URL(central.centralUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("invalid configuration");
      return url;
    });
    const port = await step("COOPERATIVE_ADAPTER_PORT must be a whole number 0..65535", () => {
      const portText = env.COOPERATIVE_ADAPTER_PORT;
      if (portText !== undefined && (!/^\d+$/.test(portText) || Number(portText) < 0 || Number(portText) > 65535)) throw new Error("invalid configuration");
      return portText === undefined ? 0 : Number(portText);
    });
    // Optional PEM CA for a private central. Public, so no mode rule; HTTPS only.
    const caFile = (central as { centralCaFile?: string }).centralCaFile;
    let ca: string | undefined;
    if (caFile !== undefined) {
      ca = await step("centralCaFile must be an absolute path to a small regular PEM certificate file (not a symlink) and centralUrl must be https", async () => {
        if (!isAbsolute(caFile) || centralUrl.protocol !== "https:") throw new Error("invalid configuration");
        const pem = await readPublicPem(caFile);
        new X509Certificate(pem);
        return pem;
      });
    }
    const incarnation = await step("incarnation file must be an absolute path to a private file holding exactly incarnationId and token", async () => {
      if (!isAbsolute(central.incarnationFile)) throw new Error("invalid configuration");
      const value = await readPrivateJson(central.incarnationFile);
      if (!exactObject(value, ["incarnationId", "token"])) throw new Error("invalid configuration");
      return value;
    });
    const handler = await step("adapter settings were refused (tokens or central URL)", () => createCooperativeAdapter({
      centralUrl: central.centralUrl,
      localToken: central.localToken,
      supervisorToken: central.supervisorToken,
      incarnationId: incarnation.incarnationId,
      incarnationToken: incarnation.token,
      centralFetch: (input, init) => fetch(input, ca ? { ...init, tls: { ca } } as RequestInit : init),
      allowLoopbackHttp: true,
      requestTimeoutMs,
    }));
    const listener = await step("could not listen on 127.0.0.1 at the chosen port (in use?)", () => createCooperativeListener({ handler, port, shutdownTimeoutMs: requestTimeoutMs + shutdownMarginMs }));
    return { url: `http://127.0.0.1:${listener.port}`, stop: listener.stop };
  } catch {
    throw new Error(`cooperative adapter startup failed: ${reason}`);
  }
}

if (import.meta.main) {
  startCooperativeAdapter().then((running) => {
    const stop = () => { void running.stop().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(JSON.stringify({ url: running.url }));
  }).catch((error) => { console.error(error instanceof Error && error.message.startsWith("cooperative adapter startup failed") ? error.message : "cooperative adapter startup failed"); process.exitCode = 1; });
}