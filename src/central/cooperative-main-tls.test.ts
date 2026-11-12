import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cooperativeConfig, runCooperativeCli, startCooperative } from "./cooperative-main.ts";
import { disposableCooperativeRole } from "./disposable-role-fixture.ts";

const schema = () => `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;
const valid = { COOPERATIVE_DATABASE_URL: "postgres://test@127.0.0.1:57507/fleet_control_test", COOPERATIVE_RUNTIME_DATABASE_URL: `postgres://cooperative_runtime_${"a".repeat(32)}@127.0.0.1:57507/fleet_control_test`, COOPERATIVE_SCHEMA: schema(), COOPERATIVE_CREDENTIALS_FILE: "/tmp/credentials", COOPERATIVE_INCARNATION_FILE: "/tmp/fleet-incarnation-never-created.json", COOPERATIVE_PORT: "0" };

async function makeCert(dir: string, name: string) {
  const cert = join(dir, name + "-cert.pem"), key = join(dir, name + "-key.pem");
  const generated = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "ignore" });
  expect(await generated.exited).toBe(0);
  return { cert, key };
}

test("TLS configuration needs both absolute files and keeps the loopback bind", () => {
  expect(cooperativeConfig(valid).tls).toBeUndefined();
  expect(() => cooperativeConfig({ ...valid, COOPERATIVE_TLS_CERT_FILE: "/c.pem" })).toThrow("both");
  expect(() => cooperativeConfig({ ...valid, COOPERATIVE_TLS_KEY_FILE: "/k.pem" })).toThrow("both");
  expect(() => cooperativeConfig({ ...valid, COOPERATIVE_TLS_CERT_FILE: "c.pem", COOPERATIVE_TLS_KEY_FILE: "/k.pem" })).toThrow("absolute");
  expect(cooperativeConfig({ ...valid, COOPERATIVE_TLS_CERT_FILE: "/c.pem", COOPERATIVE_TLS_KEY_FILE: "/k.pem" }).tls).toEqual({ certFile: "/c.pem", keyFile: "/k.pem" });
  expect(() => cooperativeConfig({ ...valid, COOPERATIVE_TLS_CERT_FILE: "/c.pem", COOPERATIVE_TLS_KEY_FILE: "/k.pem", COOPERATIVE_HOST: "0.0.0.0" })).toThrow();
});

test("a mismatched certificate fails before any database contact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-cooperative-tls-"));
  try {
    const a = await makeCert(dir, "a"), b = await makeCert(dir, "b");
    const credentials = join(dir, "credentials.json");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    await writeFile(credentials, JSON.stringify([
      { tokenHash: hash("operator-token"), principal: { role: "operator", name: "operator" } },
      { tokenHash: hash("supervisor-token"), principal: { role: "supervisor", name: "owner", principalId: "owner", hostId: "host", session: "session" } },
    ]), { mode: 0o600 });
    // The TLS check runs before provisioning, so the incarnation file is never written.
    const env = { ...valid, COOPERATIVE_CREDENTIALS_FILE: credentials, COOPERATIVE_INCARNATION_FILE: join(dir, "incarnation.json"), COOPERATIVE_TLS_CERT_FILE: a.cert, COOPERATIVE_TLS_KEY_FILE: b.key };
    const message = await startCooperative(env).then(() => "started", (error: Error) => error.message);
    expect(message).toBe("invalid cooperative TLS files");
    expect(await Bun.file(join(dir, "incarnation.json")).exists()).toBe(false);
  } finally {
    if (dir.startsWith(join(tmpdir(), "fleet-cooperative-tls-"))) await rm(dir, { recursive: true, force: true });
  }
});

const databaseUrl = process.env.CENTRAL_TEST_DATABASE_URL;
(databaseUrl ? test : test.skip)("serves the cooperative app over loopback HTTPS with a trusted certificate only", async () => {
  const name = schema();
  const dir = await mkdtemp(join(tmpdir(), "fleet-cooperative-tls-"));
  const { cert, key } = await makeCert(dir, "server");
  const credentialsFile = join(dir, "credentials.json");
  const incarnationFile = join(dir, "incarnation.json");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const operator = crypto.randomUUID(), supervisor = crypto.randomUUID();
  await writeFile(credentialsFile, JSON.stringify([
    { tokenHash: hash(operator), principal: { role: "operator", name: "operator" } },
    { tokenHash: hash(supervisor), principal: { role: "supervisor", name: "owner", principalId: "owner", hostId: "host", session: "session" } },
  ]), { mode: 0o600 });
  let running: Awaited<ReturnType<typeof startCooperative>> | undefined;
  let fixture: Awaited<ReturnType<typeof disposableCooperativeRole>> | undefined;
  const admin = new SQL(databaseUrl!);
  let owned = false;
  try {
    fixture = await disposableCooperativeRole(databaseUrl!);
    if ((await admin`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${name}`).length) throw new Error("disposable schema already exists");
    owned = true;
    const cli = await runCooperativeCli({ COOPERATIVE_DATABASE_URL: databaseUrl!, COOPERATIVE_RUNTIME_DATABASE_URL: fixture.runtimeUrl, COOPERATIVE_SCHEMA: name, COOPERATIVE_CREDENTIALS_FILE: credentialsFile, COOPERATIVE_INCARNATION_FILE: incarnationFile, COOPERATIVE_PORT: "0", COOPERATIVE_TLS_CERT_FILE: cert, COOPERATIVE_TLS_KEY_FILE: key });
    running = cli.running;
    const base = `https://127.0.0.1:${running.server.port}`;
    expect(JSON.parse(cli.line)).toEqual({ url: base, incarnationId: running.incarnationId });
    const ca = await Bun.file(cert).text();
    const headers = { authorization: `Bearer ${operator}`, "content-type": "application/json" };
    await expect(fetch(`${base}/api/commands`, { headers })).rejects.toThrow(/self.signed|DEPTH_ZERO/i);
    await expect(fetch(`http://127.0.0.1:${running.server.port}/api/commands`, { headers })).rejects.toThrow();
    const created = await fetch(`${base}/api/commands`, { method: "POST", headers, body: JSON.stringify({ hostId: "host", target: "session", text: "synthetic tls", idempotencyKey: "tls-1" }), tls: { ca } } as RequestInit);
    expect(created.status).toBe(201);
    const { command } = await created.json() as { command: { id: string } };
    const inspected = await fetch(`${base}/api/commands/${command.id}/cooperative`, { headers, tls: { ca } } as RequestInit);
    expect(inspected.status).toBe(200);
  } finally {
    try {
      await running?.stop();
      if (owned) await admin`DROP SCHEMA IF EXISTS ${admin(name)} CASCADE`;
    } finally {
      try { await fixture?.cleanup(); } finally {
        await admin.close();
        if (dir.startsWith(join(tmpdir(), "fleet-cooperative-tls-"))) await rm(dir, { recursive: true, force: true });
      }
    }
  }
}, 30_000);
