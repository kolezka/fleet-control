import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateService, initService, provisionService, serviceConfig, SERVICE_SCHEMA, STATE_LAYOUT, startService } from "./cooperative-service.ts";
import { SERVICE_RUNTIME_ROLE } from "./cooperative-provision.ts";
import { centralTestDatabaseUrl } from "./test-database-url.ts";

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
    await initService({ COOPERATIVE_STATE_DIR: state, COOPERATIVE_PORT: "1", COOPERATIVE_SUPERVISOR_HOST: "mini" });
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
