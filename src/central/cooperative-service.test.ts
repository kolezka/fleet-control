import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateService, initService, provisionService, serviceConfig, SERVICE_SCHEMA, STATE_LAYOUT, startService } from "./cooperative-service.ts";
import { SERVICE_RUNTIME_ROLE } from "./data/cooperative-provision.ts";
import { centralTestDatabaseUrl } from "./test-database-url.ts";
import { parseCredentials, serveCooperative } from "./cooperative-main.ts";

const freePort = () => { const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = probe.port!; probe.stop(true); return port; };
const temp = () => mkdtemp(join(tmpdir(), "fleet-cooperative-service-"));

test("service configuration needs explicit files and port and binds only loopback or container any", () => {
  const valid = { COOPERATIVE_RUNTIME_URL_FILE: "/s/runtime-url", COOPERATIVE_CREDENTIALS_FILE: "/s/credentials.json", COOPERATIVE_PORT: "4881" };
  expect(serviceConfig(valid).host).toBe("127.0.0.1");
  expect(serviceConfig({ ...valid, COOPERATIVE_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  for (const overrides of [
    { COOPERATIVE_HOST: "192.168.50.15" }, { COOPERATIVE_HOST: "localhost" }, { COOPERATIVE_PORT: undefined }, { COOPERATIVE_PORT: "0" },
    { COOPERATIVE_PORT: "65536" }, { COOPERATIVE_RUNTIME_URL_FILE: "runtime-url" }, { COOPERATIVE_CREDENTIALS_FILE: undefined },
  ]) expect(() => serviceConfig({ ...valid, ...overrides })).toThrow();
});

test("init writes private files once, refuses a second run and keeps tokens out of credentials", async () => {
  const dir = await temp();
  try {
    const env = { COOPERATIVE_STATE_DIR: join(dir, "state"), COOPERATIVE_PORT: "4881", COOPERATIVE_SUPERVISOR_HOST: "mini" };
    await initService(env);
    const L = STATE_LAYOUT;
    for (const name of [L.postgresPassword, L.adminUrl, L.credentials, L.operatorToken, L.adapter, L.localToken]) expect((await stat(join(dir, "state", name))).mode & 0o777).toBe(0o600);
    for (const sub of ["pg", "admin", "service", "client"]) expect((await stat(join(dir, "state", sub))).mode & 0o777).toBe(0o700);
    const operator = (await Bun.file(join(dir, "state", L.operatorToken)).text());
    const credentials = await Bun.file(join(dir, "state", L.credentials)).text();
    const adapter = await Bun.file(join(dir, "state", L.adapter)).json();
    expect(credentials).not.toContain(operator);
    expect(credentials).toContain(createHash("sha256").update(operator).digest("hex"));
    expect(credentials).not.toContain(adapter.supervisorToken);
    expect(adapter.centralUrl).toBe("http://127.0.0.1:4881/mcp");
    expect(adapter.incarnationFile).toBe(join(dir, "state", L.incarnation));
    // Only the listener's directory: no admin URL, postgres password or client tokens.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(join(dir, "state", "service"))).sort()).toEqual(["credentials.json"]);
    const before = await Bun.file(join(dir, "state", L.adminUrl)).text();
    await expect(initService(env)).rejects.toThrow("already exists");
    expect(await Bun.file(join(dir, "state", L.adminUrl)).text()).toBe(before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("activate refuses an existing incarnation file before touching the database", async () => {
  const dir = await temp();
  try {
    const runtimeUrl = join(dir, "runtime-url"), credentials = join(dir, "credentials.json"), incarnation = join(dir, "incarnation.json");
    // Unreachable port: an attempted connection would fail differently.
    await writeFile(runtimeUrl, `postgres://${SERVICE_RUNTIME_ROLE}:x@127.0.0.1:1/fleet`, { mode: 0o600 });
    await initService({ COOPERATIVE_STATE_DIR: join(dir, "s"), COOPERATIVE_PORT: "1", COOPERATIVE_SUPERVISOR_HOST: "h" });
    await writeFile(credentials, await Bun.file(join(dir, "s", STATE_LAYOUT.credentials)).text(), { mode: 0o600 });
    await writeFile(incarnation, "keep", { mode: 0o600 });
    await expect(activateService({ COOPERATIVE_RUNTIME_URL_FILE: runtimeUrl, COOPERATIVE_CREDENTIALS_FILE: credentials, COOPERATIVE_INCARNATION_FILE: incarnation })).rejects.toThrow("EEXIST");
    expect(await Bun.file(incarnation).text()).toBe("keep");
    await writeFile(join(dir, "other-url"), "postgres://postgres:x@127.0.0.1:1/fleet", { mode: 0o600 });
    await expect(activateService({ COOPERATIVE_RUNTIME_URL_FILE: join(dir, "other-url"), COOPERATIVE_CREDENTIALS_FILE: credentials, COOPERATIVE_INCARNATION_FILE: join(dir, "new.json") })).rejects.toThrow("service runtime role");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const twoSupervisors = () => [
  { tokenHash: "a".repeat(64), principal: { role: "operator" as const, name: "operator" } },
  ...["me-desktop", "mac-mini-mariusz"].map((hostId, i) => ({ tokenHash: String(i + 1).repeat(64), principal: { role: "supervisor" as const, name: hostId, principalId: hostId, hostId, session: "supervisor" } })),
];

test("multiple supervisors require parser opt-in and persist refuses them before SQL", async () => {
  const credentials = twoSupervisors();
  expect(() => parseCredentials(JSON.stringify(credentials))).toThrow("one supervisor");
  expect(parseCredentials(JSON.stringify(credentials), { allowMultipleSupervisors: true })).toEqual(credentials);
  for (const invalid of [credentials.slice(0, 1), credentials.slice(1), [...credentials, { tokenHash: "b".repeat(64), principal: { role: "host", name: "host", hostId: "host" } }]]) {
    expect(() => parseCredentials(JSON.stringify(invalid), { allowMultipleSupervisors: true })).toThrow();
  }
  await expect(serveCooperative({ runtimeDatabaseUrl: "postgres://unused@127.0.0.1:1/fleet", schema: "unused", credentials, hostname: "127.0.0.1", port: 0, shutdownGraceMs: 1, persist: async () => {} })).rejects.toThrow("exactly one supervisor");
});

test("activation rejects ambiguous, incomplete, missing and duplicate slot selections before SQL or file creation", async () => {
  const dir = await temp();
  try {
    const runtime = join(dir, "runtime"), credentials = join(dir, "credentials"), incarnation = join(dir, "incarnation");
    await writeFile(runtime, `postgres://${SERVICE_RUNTIME_ROLE}:x@127.0.0.1:1/fleet`, { mode: 0o600 });
    const env = { COOPERATIVE_RUNTIME_URL_FILE: runtime, COOPERATIVE_CREDENTIALS_FILE: credentials, COOPERATIVE_INCARNATION_FILE: incarnation };
    await writeFile(credentials, JSON.stringify(twoSupervisors()), { mode: 0o600 });
    for (const selection of [{}, { COOPERATIVE_SUPERVISOR_HOST: "mac-mini-mariusz" }, { COOPERATIVE_SUPERVISOR_SESSION: "supervisor" }, { COOPERATIVE_SUPERVISOR_HOST: "absent", COOPERATIVE_SUPERVISOR_SESSION: "supervisor" }, { COOPERATIVE_SUPERVISOR_HOST: "mac-mini-mariusz", COOPERATIVE_SUPERVISOR_SESSION: "absent" }]) {
      await expect(activateService({ ...env, ...selection })).rejects.toThrow("supervisor selection");
      expect(await Bun.file(incarnation).exists()).toBe(false);
    }
    const duplicate = twoSupervisors();
    const principal = duplicate[2]!.principal;
    if (principal.role !== "supervisor") throw new Error("fixture supervisor missing");
    principal.hostId = "me-desktop";
    await writeFile(credentials, JSON.stringify(duplicate), { mode: 0o600 });
    await expect(activateService({ ...env, COOPERATIVE_SUPERVISOR_HOST: "me-desktop", COOPERATIVE_SUPERVISOR_SESSION: "supervisor" })).rejects.toThrow("supervisor selection");
    expect(await Bun.file(incarnation).exists()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("external Host configuration requires one exact DNS hostname and explicit port", () => {
  const env = { COOPERATIVE_RUNTIME_URL_FILE: "/s/runtime", COOPERATIVE_CREDENTIALS_FILE: "/s/credentials", COOPERATIVE_PORT: "4881" };
  expect(serviceConfig(env).externalHost).toBeUndefined();
  expect(serviceConfig({ ...env, COOPERATIVE_EXTERNAL_HOST: "" }).externalHost).toBeUndefined();
  expect(serviceConfig({ ...env, COOPERATIVE_EXTERNAL_HOST: "central.example.ts.net:4881" }).externalHost).toBe("central.example.ts.net:4881");
  for (const value of ["*.example.com:4881", "example.com", "https://example.com:4881", "user@example.com:4881", "example.com:4881/", "example.com:0", "example.com:65536", "example.com:04881", " example.com:4881", "example..com:4881", "-example.com:4881", "example.com:4881,other.com:4881", "example.com:4881\n", "EXAMPLE.com:4881"]) {
    expect(() => serviceConfig({ ...env, COOPERATIVE_EXTERNAL_HOST: value })).toThrow("external Host");
  }
});

const adminUrl = centralTestDatabaseUrl(process.env);
(adminUrl ? test : test.skip)("provision, activate and restart: same incarnation survives restart, re-activation fences it", async () => {
  const admin = new SQL(adminUrl!);
  const existing = await admin`SELECT (SELECT count(*)::int FROM pg_namespace WHERE nspname = ${SERVICE_SCHEMA}) + (SELECT count(*)::int FROM pg_roles WHERE rolname = ${SERVICE_RUNTIME_ROLE}) AS n`;
  if (existing[0].n !== 0) { await admin.close(); throw new Error("service schema or role already exists in the test database; remove it first"); }
  const dir = await temp();
  const state = join(dir, "state");
  let provisioned = false;
  const servers: { stop(): Promise<void> }[] = [];
  try {
    await initService({ COOPERATIVE_STATE_DIR: state, COOPERATIVE_PORT: "1", COOPERATIVE_SUPERVISOR_HOST: "me-desktop" });
    await writeFile(join(dir, "admin-url"), adminUrl!.replace("postgres://postgres@", "postgres://postgres:unused@"), { mode: 0o600 });
    const env = { COOPERATIVE_ADMIN_URL_FILE: join(dir, "admin-url"), COOPERATIVE_RUNTIME_URL_FILE: join(dir, "runtime-url"), COOPERATIVE_CREDENTIALS_FILE: join(state, STATE_LAYOUT.credentials), COOPERATIVE_INCARNATION_FILE: join(dir, "incarnation.json"), COOPERATIVE_PORT: String(freePort()) };
    await provisionService(env);
    provisioned = true;
    expect((await stat(env.COOPERATIVE_RUNTIME_URL_FILE)).mode & 0o777).toBe(0o600);
    await expect(provisionService({ ...env, COOPERATIVE_RUNTIME_URL_FILE: join(dir, "second-url") })).rejects.toThrow("provisioning failed");
    expect(await Bun.file(join(dir, "second-url")).exists()).toBe(false);
    const [role] = await admin`SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = ${SERVICE_RUNTIME_ROLE}`;
    expect(role).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
    const first = await activateService(env);
    const firstCredential = await Bun.file(env.COOPERATIVE_INCARNATION_FILE).json();
    expect(firstCredential.incarnationId).toBe(first.incarnationId);
    const counts = async () => (await admin`SELECT count(*)::int AS all, count(*) FILTER (WHERE active)::int AS active FROM ${admin(SERVICE_SCHEMA)}.central_supervisor_incarnations_v2`)[0];
    for (let i = 0; i < 2; i++) {
      const running = await startService(env);
      servers.push(running);
      expect(running.incarnationId).toBeUndefined();
      await running.stop();
      servers.pop();
    }
    expect(await counts()).toEqual({ all: 1, active: 1 });
    const second = await activateService({ ...env, COOPERATIVE_INCARNATION_FILE: join(dir, "incarnation-2.json") });
    expect(second.incarnationId).not.toBe(first.incarnationId);
    expect(await counts()).toEqual({ all: 2, active: 1 });
    const [active] = await admin`SELECT id FROM ${admin(SERVICE_SCHEMA)}.central_supervisor_incarnations_v2 WHERE active`;
    expect(active.id).toBe(second.incarnationId);

    const configured = await Bun.file(env.COOPERATIVE_CREDENTIALS_FILE).json();
    configured.push(twoSupervisors()[2]);
    await writeFile(env.COOPERATIVE_CREDENTIALS_FILE, JSON.stringify(configured), { mode: 0o600 });
    const externalHost = "central.example.ts.net:4881";
    const running = await startService({ ...env, COOPERATIVE_EXTERNAL_HOST: externalHost });
    servers.push(running);
    expect((await admin`SELECT principal_id FROM ${admin(SERVICE_SCHEMA)}.central_supervisor_identities_v2 ORDER BY principal_id`).length).toBe(2);
    expect(await counts()).toEqual({ all: 2, active: 1 });
    const request = (host: string, extra: Record<string, string> = {}) => fetch(`${running.url}/api/commands`, { headers: { host, ...extra } });
    expect((await request(externalHost)).status).toBe(401);
    expect((await request(`127.0.0.1:${running.server.port}`)).status).toBe(401);
    for (const host of ["other.example.ts.net:4881", "central.example.ts.net:4882", "central.example.ts.net", "central.example.ts.net.evil:4881"]) {
      expect((await request(host, { "x-forwarded-host": externalHost, forwarded: `host=${externalHost}` })).status).toBe(403);
    }
    await running.stop();
    servers.pop();
    const added = await activateService({ ...env, COOPERATIVE_SUPERVISOR_HOST: "mac-mini-mariusz", COOPERATIVE_SUPERVISOR_SESSION: "supervisor", COOPERATIVE_INCARNATION_FILE: join(dir, "mini-incarnation.json") });
    expect(await counts()).toEqual({ all: 3, active: 2 });
    const activeIds = async () => (await admin`SELECT id FROM ${admin(SERVICE_SCHEMA)}.central_supervisor_incarnations_v2 WHERE active ORDER BY id`).map((row: { id: string }) => row.id).sort();
    expect(await activeIds()).toEqual([second.incarnationId, added.incarnationId].sort());
    const restarted = await startService(env);
    servers.push(restarted);
    expect((await fetch(`${restarted.url}/api/commands`, { headers: { host: externalHost } })).status).toBe(403);
    expect(await activeIds()).toEqual([second.incarnationId, added.incarnationId].sort());
    await restarted.stop();
    servers.pop();
  } finally {
    await Promise.allSettled(servers.map((s) => s.stop()));
    if (provisioned) {
      await admin`DROP SCHEMA ${admin(SERVICE_SCHEMA)} CASCADE`;
      await admin`DROP ROLE ${admin(SERVICE_RUNTIME_ROLE)}`;
    }
    await admin.close();
    await rm(dir, { recursive: true, force: true });
  }
});
