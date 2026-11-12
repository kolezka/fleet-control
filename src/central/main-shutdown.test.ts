import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Namespace import so each test still runs (and fails on behaviour) against a build without the constant.
import * as central from "./main.ts";
import { createLegacyFakeSql } from "./test-fixtures/legacy-fake-sql.ts";

// In-process tests inject the fake SQL through startCentral's dependencies and serve on a real
// 127.0.0.1 ephemeral port. The signal test runs the real entry point in a child process under a
// --preload fixture; mock.module is never used here. The fake SQL never opens a connection.
const operatorToken = "operator-token-for-legacy-shutdown-test";
const hostToken = "host-token-for-legacy-shutdown-test";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const credentials = JSON.stringify([
  { tokenHash: hash(operatorToken), principal: { name: "op", role: "operator" } },
  { tokenHash: hash(hostToken), principal: { name: "host", role: "host", hostId: "host-a" } },
]);
const env = { CENTRAL_DATABASE_URL: "postgres://fake.invalid/never-connected", CENTRAL_CREDENTIALS_FILE: "fixture.json", CENTRAL_PORT: "4567" };
const preload = join(import.meta.dir, "test-fixtures", "legacy-central-shutdown-preload.ts");

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms); })])
    .finally(() => clearTimeout(timer));
}

function postCommand(port: number, key = "k-stop") {
  return fetch(`http://127.0.0.1:${port}/api/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify({ hostId: "h1", target: "t", text: "echo hi", idempotencyKey: key }),
  }).then((response) => response.status, (error: unknown) => `error ${(error as { code?: string })?.code ?? "unknown"}`);
}

async function startInProcess(delayMs: number, options?: { shutdownGraceMs?: number }) {
  const log: string[] = [];
  const begun = Promise.withResolvers<void>();
  const record = (event: string) => { log.push(event); if (event === "tx begin k-stop") begun.resolve(); };
  let port = 0;
  const running = await central.startCentral(env, {
    readCredentials: async () => credentials,
    createSql: () => createLegacyFakeSql(record, delayMs),
    serve: (serveOptions) => { const server = Bun.serve({ ...serveOptions, port: 0 }); port = server.port!; return server; },
  }, options);
  // Lazy so a test that never waits does not leave a timer that rejects later and fails another test.
  return { running, port, log, begun: () => within(begun.promise, 5_000, "transaction begin") };
}

function expectCommitBeforeClose(log: string[]) {
  const commit = log.indexOf("tx commit k-stop");
  expect(commit).toBeGreaterThanOrEqual(0);
  expect(log.indexOf("sql close")).toBeGreaterThan(commit);
}

test("stop() lets an in-flight command commit and reply 201 before the pool closes", async () => {
  const { running, port, log, begun } = await startInProcess(400);
  let stop: Promise<void> | undefined;
  try {
    const status = postCommand(port);
    await begun();
    stop = running.stop();
    expect(await within(status, 5_000, "client response")).toBe(201);
    await within(stop, 5_000, "stop");
    expectCommitBeforeClose(log);
  } finally {
    await (stop ?? running.stop()).catch(() => {});
  }
});

test("stop() force-closes after the grace deadline but still waits for SQL work before closing the pool", async () => {
  const { running, port, log, begun } = await startInProcess(400, { shutdownGraceMs: 50 });
  let stop: Promise<void> | undefined;
  try {
    const status = postCommand(port);
    await begun();
    stop = running.stop();
    await within(stop, 5_000, "stop");
    // The client loses its connection: the committed outcome is unknown to it.
    expect(String(await within(status, 5_000, "client response"))).toStartWith("error");
    expectCommitBeforeClose(log);
  } finally {
    await (stop ?? running.stop()).catch(() => {});
  }
});

test("stop() closes open host WebSockets with 1001 instead of waiting for the grace deadline", async () => {
  const { running, port, log } = await startInProcess(0, { shutdownGraceMs: 4_000 });
  const BunSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new BunSocket(`ws://127.0.0.1:${port}/api/host/socket`, { headers: { authorization: `Bearer ${hostToken}` } });
  try {
    await within(new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; }), 5_000, "socket open");
    const closed = new Promise<number>((resolve) => { socket.onclose = (event) => resolve(event.code); });
    const started = performance.now();
    await within(running.stop(), 5_000, "stop");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await within(closed, 5_000, "socket close")).toBe(1001);
    expect(log).toContain("sql close");
  } finally {
    socket.close();
  }
});

test("rejects an invalid shutdown grace before any I/O", async () => {
  expect((central as { CENTRAL_SHUTDOWN_GRACE_MS?: number }).CENTRAL_SHUTDOWN_GRACE_MS).toBe(10_000);
  for (const shutdownGraceMs of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
    let io = 0;
    const deps = {
      readCredentials: async () => { io++; return credentials; },
      createSql: () => { io++; throw new Error("unexpected SQL"); },
      serve: () => { io++; throw new Error("unexpected serve"); },
    };
    await expect(central.startCentral(env, deps, { shutdownGraceMs })).rejects.toThrow("invalid shutdown grace");
    expect(io).toBe(0);
  }
});

async function freePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

// Collects child stderr and resolves once a line appears, so tests signal only after the transaction began.
function watchStderr(stream: ReadableStream<Uint8Array>) {
  let text = "";
  const waiters: { line: string; resolve: () => void }[] = [];
  const done = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      for (const waiter of waiters) if (text.includes(waiter.line)) waiter.resolve();
    }
    return text;
  })();
  const seen = (line: string) => new Promise<void>((resolve) => { if (text.includes(line)) resolve(); else waiters.push({ line, resolve }); });
  return { done, seen };
}

async function startCli(txMs: string) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-legacy-central-shutdown-"));
  let child: ReturnType<typeof spawnChild>;
  let port: number;
  try {
    const credentialsFile = join(dir, "credentials.json");
    await writeFile(credentialsFile, credentials, { mode: 0o600 });
    port = await freePort();
    child = spawnChild(credentialsFile, port, txMs);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return startedCli(dir, child, port);
}

function spawnChild(credentialsFile: string, port: number, txMs: string) {
  // Minimal env: no ambient PG* variables reach the child.
  return Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "main.ts")], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_TX_MS: txMs, CENTRAL_DATABASE_URL: env.CENTRAL_DATABASE_URL, CENTRAL_CREDENTIALS_FILE: credentialsFile, CENTRAL_PORT: String(port) },
    stdout: "ignore", stderr: "pipe", stdin: "ignore",
  });
}

function startedCli(dir: string, child: ReturnType<typeof spawnChild>, port: number) {
  const stderr = watchStderr(child.stderr);
  // The legacy entry prints nothing on success, so poll until the listener answers.
  const ready = async () => {
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error("child exited before listening");
      try { await fetch(`http://127.0.0.1:${port}/unknown`); return; } catch { await Bun.sleep(25); }
    }
    throw new Error("listener never answered");
  };
  return { dir, child, stderr, port, ready };
}

const events = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("[fake] ")).map((line) => line.slice(7).trim());

test("SIGTERM on the CLI entry drains an in-flight command, replies 201 and exits cleanly", async () => {
  const cli = await startCli("400");
  try {
    await within(cli.ready(), 10_000, "listener ready");
    const status = postCommand(cli.port);
    await within(cli.stderr.seen("[fake] tx begin k-stop"), 10_000, "transaction begin");
    cli.child.kill("SIGTERM");
    expect(await within(status, 10_000, "client response")).toBe(201);
    expect(await within(cli.child.exited, 10_000, "child exit")).toBe(0);
    expect(cli.child.signalCode).toBeNull();
    const text = await within(cli.stderr.done, 5_000, "child stderr");
    expect(text).not.toContain(operatorToken);
    const log = events(text);
    expect(log).toContain("sql open");
    expectCommitBeforeClose(log);
  } finally {
    cli.child.kill("SIGKILL");
    await rm(cli.dir, { recursive: true, force: true });
  }
}, 20_000);

test("a second SIGTERM during the drain falls back to the default kill", async () => {
  const cli = await startCli("5000");
  try {
    await within(cli.ready(), 10_000, "listener ready");
    const status = postCommand(cli.port);
    await within(cli.stderr.seen("[fake] tx begin k-stop"), 10_000, "transaction begin");
    cli.child.kill("SIGTERM");
    // The first handler removes both listeners synchronously; give it time to run.
    await Bun.sleep(300);
    cli.child.kill("SIGTERM");
    await within(cli.child.exited, 10_000, "child exit");
    expect(cli.child.signalCode).toBe("SIGTERM");
    expect(await within(status, 5_000, "client response")).not.toBe(201);
    expect(await within(cli.stderr.done, 5_000, "child stderr")).not.toContain("[fake] tx commit k-stop");
  } finally {
    cli.child.kill("SIGKILL");
    await rm(cli.dir, { recursive: true, force: true });
  }
}, 20_000);
