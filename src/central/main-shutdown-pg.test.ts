import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupCooperativeRole, disposableCooperativeRole } from "./disposable-role-fixture.ts";
import { startCentral } from "./main.ts";

// Legacy central shutdown against real PostgreSQL. The legacy entry point uses unqualified
// table names, so each run gets a disposable role whose search_path is its own schema.
// A second connection holds the command event lock, so a submitted command stops inside its
// transaction at a known point. This fixes the order of events; it is not a load test.
// Skipped unless CENTRAL_TEST_DATABASE_URL is set.
const databaseUrl = process.env.CENTRAL_TEST_DATABASE_URL;
const pgTest = databaseUrl ? test : test.skip;
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function within<T>(work: Promise<T>, what: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function freePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

async function setup() {
  const schema = `legacy_shutdown_test_${randomBytes(16).toString("hex")}`;
  const dir = await mkdtemp(join(tmpdir(), "fleet-legacy-shutdown-pg-"));
  const operator = token(), host = token();
  const secrets = [operator, host];
  const admin = new SQL(databaseUrl!);
  let fixture: Awaited<ReturnType<typeof disposableCooperativeRole>> | undefined;
  let schemaCreated = false;
  const releases: (() => void)[] = [];
  const settle: Promise<unknown>[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const sockets: WebSocket[] = [];
  let running: Awaited<ReturnType<typeof startCentral>> | undefined;
  try {
    fixture = await disposableCooperativeRole(databaseUrl!);
    secrets.push(new URL(fixture.runtimeUrl).password, fixture.runtimeUrl);
    // Both names contain only generated lowercase hexadecimal and fixed prefixes.
    await admin.unsafe(`CREATE SCHEMA "${schema}" AUTHORIZATION "${fixture.role}"`);
    schemaCreated = true;
    await admin.unsafe(`ALTER ROLE "${fixture.role}" SET search_path = "${schema}"`);
    await writeFile(join(dir, "credentials.json"), JSON.stringify([
      { tokenHash: hash(operator), principal: { name: "operator", role: "operator" } },
      { tokenHash: hash(host), principal: { name: "host", role: "host", hostId: "host" } },
    ]), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (schemaCreated) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await fixture?.cleanup().catch(() => {});
    await admin.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const role = fixture.role;
  const env = { CENTRAL_DATABASE_URL: fixture.runtimeUrl, CENTRAL_CREDENTIALS_FILE: join(dir, "credentials.json") };
  const noSecrets = (text: string) => { for (const secret of secrets) expect(text).not.toContain(secret); };

  return {
    noSecrets,
    // The real CLI entry point in its own process, with no ambient environment beyond PATH and HOME.
    async spawnCentral() {
      const port = await freePort();
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env, CENTRAL_PORT: String(port) }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      children.push(child);
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then((parts) => parts.join(""));
      const url = `http://127.0.0.1:${port}`;
      // The legacy entry prints nothing on success, so poll until the listener answers.
      for (let i = 0; ; i++) {
        if (child.exitCode !== null) throw new Error("central exited before listening");
        if (i === 400) throw new Error("listener never answered");
        const status = await fetch(`${url}/api/commands`).then((response) => { void response.body?.cancel(); return response.status; }, () => 0);
        // Positive control for the refused() probe: the listener answers before any signal.
        if (status === 401) break;
        await Bun.sleep(25);
      }
      return { process: child, url, output: () => output };
    },
    // The same code in this process, so the test can pick a short grace deadline.
    async startInProcess(shutdownGraceMs: number) {
      let port = 0;
      running = await startCentral({ ...env, CENTRAL_PORT: "1" }, {
        readCredentials: (path) => Bun.file(path).text(),
        createSql: (url) => new SQL(url),
        serve: (options) => { const listener = Bun.serve({ ...options, port: 0 }); port = listener.port!; return listener; },
      }, { shutdownGraceMs });
      return { url: `http://127.0.0.1:${port}`, stop: () => running!.stop() };
    },
    // An idle host WebSocket. `closed` resolves with the close code the client sees.
    async hostSocket(url: string) {
      const socket = new WebSocket(`${url.replace("http", "ws")}/api/host/socket`, { headers: { Authorization: `Bearer ${host}` } } as unknown as string[]);
      sockets.push(socket);
      const opened = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<number>();
      socket.addEventListener("open", () => opened.resolve());
      socket.addEventListener("close", (event) => { opened.reject(new Error("host socket closed before open")); closed.resolve(event.code); });
      closed.promise.catch(() => {});
      await within(opened.promise, "host socket open");
      // Wrapped in an object: returning the promise itself would make the caller wait for the close.
      return { closed: closed.promise };
    },
    // Holds the command event lock until released, so every command submit waits behind it.
    async holdEventLock() {
      const gate = Promise.withResolvers<void>();
      const ready = Promise.withResolvers<number>();
      const done = admin.begin(async (tx) => {
        await tx`SELECT id FROM ${tx(schema)}.central_command_event_lock WHERE id = 1 FOR UPDATE`;
        const [row] = await tx`SELECT pg_backend_pid() AS pid`;
        ready.resolve(row!.pid as number);
        await gate.promise;
      });
      done.catch((error) => ready.reject(error));
      releases.push(gate.resolve);
      settle.push(done);
      const pid = await within(ready.promise, "event lock holder");
      return { pid, release: async () => { gate.resolve(); await within(done, "event lock release"); } };
    },
    submit(url: string, idempotencyKey: string): Promise<number | string> {
      const work = fetch(`${url}/api/commands`, {
        method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
        body: JSON.stringify({ hostId: "host", target: "session", text: "synthetic shutdown command", idempotencyKey }),
      }).then((response) => response.status, (error: unknown) => `error ${(error as { code?: string })?.code ?? "unknown"}`);
      settle.push(work);
      return work;
    },
    // Resolves once a backend of the disposable role waits on a lock held by the holder.
    async blockedOn(holderPid: number) {
      for (let i = 0; i < 200; i++) {
        const rows = await admin`SELECT pid FROM pg_stat_activity WHERE usename = ${role} AND wait_event_type = 'Lock' AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
        if (rows.length) return rows[0]!.pid as number;
        await Bun.sleep(25);
      }
      throw new Error("command never waited on the event lock");
    },
    // Reads the disposable schema by name, so a row here also proves the tables were not created elsewhere.
    committed: (idempotencyKey: string) => admin`SELECT c.status, (SELECT count(*)::int FROM ${admin(schema)}.central_command_events e WHERE e.command_id = c.id) AS events
      FROM ${admin(schema)}.central_commands c WHERE c.idempotency_key = ${idempotencyKey}`.then((rows) => [...rows]),
    // Polls: PostgreSQL drops a session a moment after its client closes the socket.
    async noBackends() {
      for (let i = 0; i < 200; i++) {
        const [row] = await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = ${role}`;
        if (row!.n === 0) return;
        await Bun.sleep(25);
      }
      throw new Error("central backends never closed");
    },
    async cleanup() {
      for (const release of releases) release();
      for (const socket of sockets) { try { socket.close(); } catch { /* already closed */ } }
      for (const child of children) child.kill("SIGKILL");
      await Promise.allSettled([...settle, ...children.map((child) => child.exited)]);
      try { await running?.stop(); } catch { /* reported by the test itself */ }
      let dropped = false;
      try {
        // The role cannot be dropped while a session of it lives or while it owns the schema.
        await this.noBackends();
        await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
        dropped = true;
      } finally {
        try { await cleanupCooperativeRole(fixture!, schema, !dropped); }
        finally { try { await admin.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
      }
    },
  };
}

// True once nothing listens on the URL any more.
async function refused(url: string) {
  for (let i = 0; i < 80; i++) {
    const open = await fetch(`${url}/api/commands`).then((response) => { void response.body?.cancel(); return true; }, () => false);
    if (!open) return true;
    await Bun.sleep(25);
  }
  return false;
}

pgTest("PostgreSQL: SIGTERM on the legacy entry closes an idle host socket, waits for a command stopped inside its transaction, replies 201 and exits cleanly", async () => {
  const s = await setup();
  try {
    const central = await s.spawnCentral();
    const host = await s.hostSocket(central.url);
    const holder = await s.holdEventLock();
    const status = s.submit(central.url, "k-drain");
    await s.blockedOn(holder.pid);

    central.process.kill("SIGTERM");
    expect(await refused(central.url)).toBe(true);
    // The idle host is told to go away at once; it does not hold the drain.
    expect(await within(host.closed, "host socket close")).toBe(1001);
    await Bun.sleep(300);
    // Still alive, still waiting, nothing committed.
    expect(central.process.exitCode).toBeNull();
    await s.blockedOn(holder.pid);
    expect(await s.committed("k-drain")).toEqual([]);

    await holder.release();
    expect(await within(status, "client response")).toBe(201);
    expect(await within(central.process.exited, "central exit")).toBe(0);
    expect(central.process.signalCode).toBeNull();
    expect(await s.committed("k-drain")).toEqual([{ status: "queued", events: 1 }]);
    await s.noBackends();
    s.noSecrets(await within(central.output(), "central output"));
  } finally { await s.cleanup(); }
}, 30_000);

pgTest("PostgreSQL: after the legacy grace deadline the client is cut off, but the command still commits before the pool closes", async () => {
  const s = await setup();
  try {
    const running = await s.startInProcess(200);
    const holder = await s.holdEventLock();
    const status = s.submit(running.url, "k-forced");
    await s.blockedOn(holder.pid);

    let stopped = false;
    const stop = running.stop().then(() => { stopped = true; });
    // The client loses its connection at the deadline: for it the outcome is unknown.
    expect(String(await within(status, "client cut off"))).toStartWith("error");
    await Bun.sleep(300);
    // stop() is still waiting for the transaction, and the pool is still open under it.
    expect(stopped).toBe(false);
    await s.blockedOn(holder.pid);
    expect(await s.committed("k-forced")).toEqual([]);

    await holder.release();
    await within(stop, "stop");
    // The command the client never heard about is durable.
    expect(await s.committed("k-forced")).toEqual([{ status: "queued", events: 1 }]);
    await s.noBackends();
  } finally { await s.cleanup(); }
}, 30_000);

pgTest("PostgreSQL: a second SIGTERM kills the legacy process and the stopped command is rolled back", async () => {
  const s = await setup();
  try {
    const central = await s.spawnCentral();
    const holder = await s.holdEventLock();
    const status = s.submit(central.url, "k-killed");
    await s.blockedOn(holder.pid);

    central.process.kill("SIGTERM");
    expect(await refused(central.url)).toBe(true);
    central.process.kill("SIGTERM");
    await within(central.process.exited, "central exit");
    expect(central.process.signalCode).toBe("SIGTERM");
    expect(String(await within(status, "client cut off"))).toStartWith("error");

    // The backend still waits on the lock after its client died. Once it gets the lock it
    // finds the connection gone and aborts, so nothing is written.
    await holder.release();
    await s.noBackends();
    expect(await s.committed("k-killed")).toEqual([]);
    s.noSecrets(await within(central.output(), "central output"));
  } finally { await s.cleanup(); }
}, 30_000);
