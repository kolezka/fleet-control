import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cooperativeConfig, runCooperativeCli, startCooperative } from "./cooperative-main.ts";
import { disposableCooperativeRole } from "./disposable-role-fixture.ts";

const schema = () => `cooperative_test_${crypto.randomUUID().replaceAll("-", "")}`;
const valid = { COOPERATIVE_DATABASE_URL: "postgres://test@127.0.0.1:57507/fleet_control_test", COOPERATIVE_RUNTIME_DATABASE_URL: `postgres://cooperative_runtime_${"a".repeat(32)}@127.0.0.1:57507/fleet_control_test`, COOPERATIVE_SCHEMA: schema(), COOPERATIVE_CREDENTIALS_FILE: "/tmp/credentials", COOPERATIVE_INCARNATION_FILE: "/tmp/fleet-incarnation-never-created.json", COOPERATIVE_PORT: "0" };

test("configuration rejects remote, ambiguous and non-disposable settings", () => {
  expect(cooperativeConfig(valid).port).toBe(0);
  for (const overrides of [
    { COOPERATIVE_DATABASE_URL: undefined },
    { COOPERATIVE_DATABASE_URL: "postgres://test@localhost:57507/fleet_control_test" },
    { COOPERATIVE_DATABASE_URL: "postgres://test@127.0.0.1:57507/fleet_control_test?host=remote" },
    { COOPERATIVE_DATABASE_URL: "postgres://test@127.0.0.1:57507/other" },
    { COOPERATIVE_RUNTIME_DATABASE_URL: undefined },
    { COOPERATIVE_RUNTIME_DATABASE_URL: "not a URL" },
    ...[
      "postgres://postgres@127.0.0.1:57507/fleet_control_test",
      `postgres://cooperative_runtime_${"a".repeat(32)}@localhost:57507/fleet_control_test`,
      `postgres://cooperative_runtime_${"a".repeat(32)}@127.0.0.1:57508/fleet_control_test`,
      `postgres://cooperative_runtime_${"a".repeat(32)}@127.0.0.1:57507/other`,
      `postgres://cooperative_runtime_${"a".repeat(32)}@127.0.0.1:57507/fleet_control_test?host=remote`,
      `postgres://cooperative_runtime_${"a".repeat(32)}@127.0.0.1:57507/fleet_control_test#fragment`,
      `https://cooperative_runtime_${"a".repeat(32)}@127.0.0.1:57507/fleet_control_test`,
    ].map((url) => ({ COOPERATIVE_RUNTIME_DATABASE_URL: url })),
    { COOPERATIVE_SCHEMA: "public" }, { COOPERATIVE_SCHEMA: undefined },
    { COOPERATIVE_HOST: "0.0.0.0" }, { COOPERATIVE_PORT: "65536" },
  ]) expect(() => cooperativeConfig({ ...valid, ...overrides })).toThrow();
});

test("configuration requires an absolute incarnation file path", () => {
  expect(cooperativeConfig(valid).incarnationFile).toBe(valid.COOPERATIVE_INCARNATION_FILE);
  for (const value of [undefined, "", "incarnation.json", "./incarnation.json", "../x.json", "/tmp/dir/"])
    expect(() => cooperativeConfig({ ...valid, COOPERATIVE_INCARNATION_FILE: value })).toThrow("absolute incarnation file path required");
});

test("startup refuses an existing incarnation file and leaves it untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-cooperative-"));
  try {
    const existing = join(dir, "incarnation.json");
    await Bun.write(existing, "keep");
    // No database is contacted: the refusal happens before credentials or provisioning.
    await expect(startCooperative({ ...valid, COOPERATIVE_INCARNATION_FILE: existing, COOPERATIVE_CREDENTIALS_FILE: join(dir, "absent") })).rejects.toThrow("incarnation file must not exist");
    expect(await Bun.file(existing).text()).toBe("keep");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const databaseUrl = process.env.CENTRAL_TEST_DATABASE_URL;
(databaseUrl ? test : test.skip)("fresh provisioned loopback server writes a private credential file and runs the cooperative flow", async () => {
  const name = schema(), failedName = schema();
  const dir = await mkdtemp(join(tmpdir(), "fleet-cooperative-"));
  const credentialsFile = join(dir, "credentials.json");
  const incarnationFile = join(dir, "incarnation.json");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const operator = crypto.randomUUID(), supervisor = crypto.randomUUID();
  await Bun.write(credentialsFile, JSON.stringify([
    { tokenHash: hash(operator), principal: { role: "operator", name: "operator" } },
    { tokenHash: hash(supervisor), principal: { role: "supervisor", name: "owner", principalId: "owner", hostId: "host", session: "session" } },
  ]));
  let running: Awaited<ReturnType<typeof startCooperative>> | undefined;
  let fixture: Awaited<ReturnType<typeof disposableCooperativeRole>> | undefined;
  const admin = new SQL(databaseUrl!);
  const ownedSchemas: string[] = [];
  try {
    fixture = await disposableCooperativeRole(databaseUrl!);
    for (const s of [name, failedName]) {
      const existing = await admin`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${s}`;
      if (existing.length) throw new Error("disposable schema already exists");
      ownedSchemas.push(s);
    }
    const env = { COOPERATIVE_DATABASE_URL: databaseUrl!, COOPERATIVE_RUNTIME_DATABASE_URL: fixture.runtimeUrl, COOPERATIVE_SCHEMA: name, COOPERATIVE_CREDENTIALS_FILE: credentialsFile, COOPERATIVE_INCARNATION_FILE: incarnationFile, COOPERATIVE_PORT: "0" };
    cooperativeConfig(env);
    const cli = await runCooperativeCli(env);
    running = cli.running;
    const file = await stat(incarnationFile);
    expect(file.mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await Bun.file(incarnationFile).text()) as { incarnationId: string; token: string };
    expect(Object.keys(stored).sort()).toEqual(["incarnationId", "token"]);
    expect(stored.incarnationId).toBe(running.incarnationId);
    expect(stored.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cli.line).not.toContain(stored.token);
    expect(JSON.parse(cli.line)).toEqual({ url: `http://127.0.0.1:${running.server.port}`, incarnationId: stored.incarnationId });
    expect(JSON.stringify(Object.keys(running))).not.toContain("token");

    const base = `http://127.0.0.1:${running.server.port}`;
    expect((await fetch(`${base}/api/commands`, { headers: { host: "evil.example" } })).status).toBe(403);
    const response = await fetch(`${base}/api/commands`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify({ hostId: "host", target: "session", text: "synthetic", idempotencyKey: "one" }) });
    expect(response.status).toBe(201);
    const { command } = await response.json() as { command: { id: string } };
    const headers = { authorization: `Bearer ${supervisor}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-fleet-incarnation-id": stored.incarnationId, "x-fleet-incarnation-token": stored.token };
    const call = async (name: string, args: object) => {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      expect(res.status).toBe(200);
      return await res.json() as any;
    };
    expect(JSON.parse((await call("cooperative_claim", { requestId: "claim" })).result.content[0].text).command.id).toBe(command.id);
    expect(JSON.parse((await call("cooperative_report", { commandId: command.id, requestId: "accept", status: "accepted", detail: "synthetic" })).result.content[0].text).event.status).toBe("accepted");
    expect(JSON.parse((await call("cooperative_report", { commandId: command.id, requestId: "done", status: "completed", detail: "synthetic done" })).result.content[0].text).event.status).toBe("completed");
    expect((await call("command_respond", { id: command.id, decision: "accepted" })).result?.isError ?? true).toBe(true);
    const inspected = await fetch(`${base}/api/commands/${command.id}/cooperative`, { headers: { authorization: `Bearer ${operator}` } });
    expect(inspected.status).toBe(200);
    const inspectedText = await inspected.text();
    expect(inspectedText).not.toContain(stored.token);
    expect((JSON.parse(inspectedText) as any).events.map((e: any) => e.status)).toEqual(["accepted", "completed"]);

    // A second start refuses the existing credential file and never overwrites it.
    const before = await Bun.file(incarnationFile).text();
    await expect(startCooperative({ ...env, COOPERATIVE_SCHEMA: schema() })).rejects.toThrow("incarnation file must not exist");
    expect(await Bun.file(incarnationFile).text()).toBe(before);

    // Write failure after activation: server stops, pool closes, error carries no token.
    const unwritable = join(dir, "missing-dir", "incarnation.json");
    const failure = await startCooperative({ ...env, COOPERATIVE_SCHEMA: failedName, COOPERATIVE_INCARNATION_FILE: unwritable }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain("could not write incarnation file");
    expect(failure!.cause).toBeUndefined();
    expect(await Bun.file(unwritable).exists()).toBe(false);
  } finally {
    try {
      await running?.stop();
      for (const s of ownedSchemas) await admin`DROP SCHEMA IF EXISTS ${admin(s)} CASCADE`;
    } finally {
      try { await fixture?.cleanup(); } finally {
        await admin.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
});
