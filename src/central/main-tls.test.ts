import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { centralConfig, startCentral } from "./main.ts";
import { HostAgentClient, type HostSocket } from "../host-agent/client.ts";

const base = { CENTRAL_DATABASE_URL: "postgres://example.invalid/test", CENTRAL_CREDENTIALS_FILE: "fixture.json" };

test("TLS config needs both absolute files and keeps the loopback bind", () => {
  expect(centralConfig(base).tls).toBeUndefined();
  expect(() => centralConfig({ ...base, CENTRAL_TLS_CERT_FILE: "/c.pem" })).toThrow("both");
  expect(() => centralConfig({ ...base, CENTRAL_TLS_KEY_FILE: "/k.pem" })).toThrow("both");
  expect(() => centralConfig({ ...base, CENTRAL_TLS_CERT_FILE: "c.pem", CENTRAL_TLS_KEY_FILE: "/k.pem" })).toThrow("absolute");
  const config = centralConfig({ ...base, CENTRAL_TLS_CERT_FILE: "/c.pem", CENTRAL_TLS_KEY_FILE: "/k.pem" });
  expect(config.tls).toEqual({ certFile: "/c.pem", keyFile: "/k.pem" });
  expect(config.hostname).toBe("127.0.0.1");
  expect(() => centralConfig({ ...base, CENTRAL_TLS_CERT_FILE: "/c.pem", CENTRAL_TLS_KEY_FILE: "/k.pem", CENTRAL_HOST: "0.0.0.0" })).toThrow();
});

function deps(credentials: string, onServe: (port: number) => void, readTlsFile?: (path: string) => Promise<string>, onSql = () => {}) {
  const sql = Object.assign(async () => [], { close: async () => {} }) as unknown as SQL;
  return {
    readCredentials: async () => credentials,
    createSql: () => { onSql(); return sql; },
    ...(readTlsFile ? { readTlsFile } : {}),
    serve: (options: any) => { const server = Bun.serve({ ...options, port: 0 }); onServe(server.port!); return server; },
  };
}

async function makeCert(dir: string, name: string) {
  const cert = join(dir, name + "-cert.pem"), key = join(dir, name + "-key.pem");
  const generated = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "ignore" });
  expect(await generated.exited).toBe(0);
  return { cert: await Bun.file(cert).text(), key: await Bun.file(key).text(), certFile: cert, keyFile: key };
}

test("rejects unreadable, corrupt or mismatched TLS files before opening the database or listener", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-control-central-tls-"));
  try {
    const a = await makeCert(dir, "a"), b = await makeCert(dir, "b");
    const env = { ...base, CENTRAL_TLS_CERT_FILE: "/c.pem", CENTRAL_TLS_KEY_FILE: "/k.pem" };
    let served = false, opened = false;
    const credentials = JSON.stringify([{ tokenHash: "0".repeat(64), principal: { name: "op", role: "operator" } }]);
    const files = (cert: string, key: string) => async (path: string) => path === "/c.pem" ? cert : key;
    const attempt = (read: (path: string) => Promise<string>) => startCentral(env, deps(credentials, () => { served = true; }, read, () => { opened = true; }));
    const unreadable = await attempt(async () => { throw new Error("secret path"); }).catch((error: Error) => error.message);
    expect(unreadable).toBe("unreadable central TLS files");
    const lines = a.cert.trim().split("\n");
    const corrupt = [lines[0], ...lines.slice(1, -1).map((line) => line.replace(/[A-Za-z]/g, "A")), lines.at(-1)].join("\n");
    for (const [cert, key] of [["not pem", a.key], [corrupt, a.key], [a.cert, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"], [a.cert, b.key]]) {
      expect(await attempt(files(cert!, key!)).catch((error: Error) => error.message)).toBe("invalid central TLS files");
    }
    expect(opened).toBe(false);
    expect(served).toBe(false);
  } finally {
    if (dir.startsWith(join(tmpdir(), "fleet-control-central-tls-"))) await rm(dir, { recursive: true, force: true });
  }
});

test("serves HTTPS and the host socket over wss with a trusted certificate only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-control-central-tls-"));
  const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
  let running: Awaited<ReturnType<typeof startCentral>> | undefined;
  let client: HostAgentClient | undefined;
  try {
    const generated = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "ignore" });
    expect(await generated.exited).toBe(0);
    await chmod(key, 0o600);
    const operator = "tls-operator-token", host = "tls-host-token";
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const credentials = JSON.stringify([
      { tokenHash: hash(operator), principal: { name: "op", role: "operator" } },
      { tokenHash: hash(host), principal: { name: "host", role: "host", hostId: "host-a" } },
    ]);
    let port = 0;
    running = await startCentral({ ...base, CENTRAL_TLS_CERT_FILE: cert, CENTRAL_TLS_KEY_FILE: key }, deps(credentials, (p) => { port = p; }));
    const ca = await Bun.file(cert).text();
    const hosts = async () => (await (await fetch(`https://127.0.0.1:${port}/api/hosts`, { headers: { authorization: `Bearer ${operator}` }, tls: { ca } } as RequestInit)).json()).hosts;
    // Negative controls: without the CA the default trust store refuses the self-signed certificate.
    await expect(fetch(`https://127.0.0.1:${port}/api/hosts`, { headers: { authorization: `Bearer ${operator}` } })).rejects.toThrow(/self.signed|DEPTH_ZERO/i);
    await expect(fetch(`http://127.0.0.1:${port}/api/hosts`, { headers: { authorization: `Bearer ${operator}` } })).rejects.toThrow();
    const errors: unknown[] = [];
    const untrusted = new HostAgentClient({
      url: `wss://127.0.0.1:${port}/api/host/socket`, hostId: "host-a", token: host,
      socketFactory: (url, options) => new (WebSocket as any)(url, options) as HostSocket,
      execute: async () => { throw new Error("dispatch disabled"); }, inventory: () => ["untrusted"],
      setTimer: () => 1, clearTimer: () => {}, onError: (error) => errors.push(error),
    });
    untrusted.start();
    for (let i = 0; i < 200 && errors.length === 0; i++) await Bun.sleep(10);
    untrusted.stop();
    expect(errors.length).toBeGreaterThan(0);
    expect(await hosts()).toEqual([]);
    client = new HostAgentClient({
      url: `wss://127.0.0.1:${port}/api/host/socket`, hostId: "host-a", token: host,
      socketFactory: (url, options) => new (WebSocket as any)(url, { ...options, tls: { ca } }) as HostSocket,
      execute: async () => { throw new Error("dispatch disabled"); }, inventory: () => ["tls-session"],
      setTimer: () => 1, clearTimer: () => {},
    });
    client.start();
    for (let i = 0; i < 200 && JSON.stringify(await hosts()) !== JSON.stringify([{ hostId: "host-a", sessions: ["tls-session"] }]); i++) await Bun.sleep(10);
    expect(await hosts()).toEqual([{ hostId: "host-a", sessions: ["tls-session"] }]);
  } finally {
    client?.stop();
    await running?.stop();
    if (dir.startsWith(join(tmpdir(), "fleet-control-central-tls-"))) await rm(dir, { recursive: true, force: true });
  }
}, 15_000);