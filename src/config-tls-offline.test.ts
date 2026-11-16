import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tlsFromEnv } from "./config.ts";

// Certificates made with openssl at test time; nothing here is a real host certificate.
const dir = await mkdtemp(join(tmpdir(), "config-tls-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
async function pair(name: string, days: number) {
  const cert = join(dir, `${name}.pem`);
  const key = join(dir, `${name}-key.pem`);
  const p = Bun.spawn(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-days", String(days), "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "ignore" });
  expect(await p.exited).toBe(0);
  return { cert, key };
}
const read = (path: string) => Bun.file(path).text();
const a = await pair("a", 365);
const b = await pair("b", 365);
const soon = await pair("soon", 10);
const later = (days: number) => new Date(Date.now() + days * 86_400_000);

test("no TLS variables means no TLS; only one of them is refused instead of plain HTTP", async () => {
  expect(await tlsFromEnv({}, read)).toBeUndefined();
  await expect(tlsFromEnv({ FLEET_CONTROL_TLS_CERT: a.cert }, read)).rejects.toThrow("must be set together");
  await expect(tlsFromEnv({ FLEET_CONTROL_TLS_KEY: a.key }, read)).rejects.toThrow("must be set together");
});

test("a valid pair loads without a warning", async () => {
  const warnings: string[] = [];
  const tls = await tlsFromEnv({ FLEET_CONTROL_TLS_CERT: a.cert, FLEET_CONTROL_TLS_KEY: a.key }, read, new Date(), (m) => warnings.push(m));
  expect(tls?.cert).toContain("BEGIN CERTIFICATE");
  expect(warnings).toEqual([]);
});

test("a key from another certificate, and files that are not PEM, are refused", async () => {
  await expect(tlsFromEnv({ FLEET_CONTROL_TLS_CERT: a.cert, FLEET_CONTROL_TLS_KEY: b.key }, read)).rejects.toThrow("does not match");
  await expect(tlsFromEnv({ FLEET_CONTROL_TLS_CERT: a.key, FLEET_CONTROL_TLS_KEY: a.key }, read)).rejects.toThrow("not a PEM certificate");
  await expect(tlsFromEnv({ FLEET_CONTROL_TLS_CERT: a.cert, FLEET_CONTROL_TLS_KEY: a.cert }, read)).rejects.toThrow("not a PEM private key");
});

test("an expired certificate is refused, one close to expiry warns, one not yet valid is refused", async () => {
  const env = { FLEET_CONTROL_TLS_CERT: soon.cert, FLEET_CONTROL_TLS_KEY: soon.key };
  await expect(tlsFromEnv(env, read, later(11))).rejects.toThrow("expired at");
  const warnings: string[] = [];
  await tlsFromEnv(env, read, new Date(), (m) => warnings.push(m));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/expires in (9|10) days/);
  await expect(tlsFromEnv(env, read, later(-1))).rejects.toThrow("not valid until");
});
