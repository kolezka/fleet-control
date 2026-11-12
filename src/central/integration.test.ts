import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCentral } from "./main.ts";

const databaseUrl = process.env.CENTRAL_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration("real loopback server authenticates and preserves idempotent commands across restart", async () => {
  const parsed = new URL(databaseUrl!);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/fleet_control_test") {
    throw new Error("integration test requires the local disposable fleet_control_test database");
  }
  const directory = await mkdtemp(join(tmpdir(), "fleet-central-test-"));
  const credentialsFile = join(directory, "credentials.json");
  const token = randomUUID();
  const hostToken = randomUUID();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const key = `integration-${randomUUID()}`;
  const input = { hostId: `host-${randomUUID()}`, target: "supervisor", text: "run integration test", idempotencyKey: key };
  const env = { CENTRAL_DATABASE_URL: databaseUrl!, CENTRAL_CREDENTIALS_FILE: credentialsFile, CENTRAL_PORT: "1" };
  const db = new SQL(databaseUrl!);
  let server: Awaited<ReturnType<typeof startCentral>> | undefined;
  let port = 0;
  let initialized = false;
  const deps = {
    readCredentials: (path: string) => Bun.file(path).text(),
    createSql: (url: string) => new SQL(url),
    serve: (options: Parameters<NonNullable<Parameters<typeof startCentral>[1]>["serve"]>[0]) => {
      const listener = Bun.serve({ ...options, port: 0 });
      port = listener.port!;
      return listener;
    },
  };
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
  const submit = (body: typeof input) => request("/api/commands", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    await writeFile(credentialsFile, JSON.stringify([
      { tokenHash: hash(token), principal: { name: "integration-operator", role: "operator" } },
      { tokenHash: hash(hostToken), principal: { name: "integration-host", role: "host", hostId: input.hostId } },
    ]), { mode: 0o600 });
    server = await startCentral(env, deps);
    initialized = true;
    expect((await request("/api/commands")).status).toBe(401);
    expect((await request("/api/commands", { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    expect((await request("/api/commands", { headers: { authorization: `Bearer ${hostToken}` } })).status).toBe(403);
    const first = await submit(input);
    expect(first.status).toBe(201);
    const created = await first.json() as { created: boolean; command: { id: string; status: string; actor: string } };
    expect(created.created).toBe(true);
    expect(created.command.status).toBe("queued");
    expect(created.command.actor).toBe("integration-operator");
    const retry = await submit(input);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ created: false, command: created.command });
    expect((await submit({ ...input, text: "different instruction" })).status).toBe(409);
    const secondKey = `${key}-second`;
    expect((await submit({ ...input, idempotencyKey: secondKey })).status).toBe(201);
    const list = (query: string) => request(`/api/commands?hostId=${encodeURIComponent(input.hostId)}&target=supervisor&status=queued&limit=1${query}`, { headers: { authorization: `Bearer ${token}` } });
    const page1 = await (await list("")).json() as { commands: { id: string }[]; nextCursor: string | null };
    expect(page1.commands).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await (await list(`&cursor=${encodeURIComponent(page1.nextCursor!)}`)).json() as { commands: { id: string }[]; nextCursor: string | null };
    expect(page2.commands).toHaveLength(1);
    expect(page2.commands[0]!.id).not.toBe(page1.commands[0]!.id);
    expect(page2.nextCursor).toBeNull();
    expect((await list("&cursor=bad")).status).toBe(400);
    await server.stop();
    server = undefined;
    server = await startCentral(env, deps);
    const fetched = await request(`/api/commands/${created.command.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({ command: created.command });
    const afterRestart = await submit(input);
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.json()).toEqual({ created: false, command: created.command });
    expect((await submit({ ...input, hostId: `${input.hostId}-other` })).status).toBe(409);
    const rows = await db`SELECT id FROM central_commands WHERE idempotency_key = ${key}`;
    expect(rows).toHaveLength(1);
    const events = await db<{ status: string }[]>`SELECT status FROM central_command_events WHERE command_id = ${created.command.id}`;
    expect(events.map((event) => event.status)).toEqual(["queued"]);
  } finally {
    try {
      if (server) await server.stop();
    } finally {
      try {
        if (initialized) {
          await db`DELETE FROM central_command_events WHERE command_id IN (SELECT id FROM central_commands WHERE idempotency_key IN (${key}, ${`${key}-second`}))`;
          await db`DELETE FROM central_commands WHERE idempotency_key IN (${key}, ${`${key}-second`})`;
        }
      } finally {
        await db.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
