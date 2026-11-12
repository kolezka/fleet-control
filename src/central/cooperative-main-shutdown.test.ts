import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fakes run only in spawned child processes through a --preload fixture, never via
// mock.module here, because module mocks leak across files in one bun test process.
// The fake SQL client never opens a connection; the URLs below only satisfy config validation.
const fixtures = join(import.meta.dir, "test-fixtures");
const preload = join(fixtures, "central-shutdown-preload.ts");
const operatorToken = "operator-token-for-shutdown-test";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "fleet-central-shutdown-"));
  const credentialsFile = join(dir, "credentials.json");
  await writeFile(credentialsFile, JSON.stringify([
    { tokenHash: hash(operatorToken), principal: { name: "op", role: "operator" } },
    { tokenHash: hash("supervisor-token-for-shutdown-test"), principal: { name: "sup", role: "supervisor", principalId: "p1", hostId: "h1", session: "s1" } },
  ]), { mode: 0o600 });
  // Minimal env: no ambient PG* variables reach the child.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    FAKE_TX_MS: "400",
    FAKE_OPERATOR_TOKEN: operatorToken,
    COOPERATIVE_DATABASE_URL: "postgres://test@127.0.0.1:57507/fleet_control_test",
    COOPERATIVE_RUNTIME_DATABASE_URL: `postgres://cooperative_runtime_${"a".repeat(32)}@127.0.0.1:57507/fleet_control_test`,
    COOPERATIVE_SCHEMA: `cooperative_test_${"b".repeat(32)}`,
    COOPERATIVE_CREDENTIALS_FILE: credentialsFile,
    COOPERATIVE_INCARNATION_FILE: join(dir, "incarnation.json"),
    COOPERATIVE_PORT: "0",
  };
  return { dir, env };
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms); })])
    .finally(() => clearTimeout(timer));
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

async function startCli(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "cooperative-main.ts")], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stderr = watchStderr(child.stderr);
  const reader = child.stdout.getReader();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const { value, done } = await within(reader.read(), 10_000, "startup line");
    if (done) throw new Error("child exited before startup");
    buffered += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const { url } = JSON.parse(buffered.slice(0, buffered.indexOf("\n")));
  const status = fetch(`${url}/api/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify({ hostId: "h1", target: "t", text: "echo hi", idempotencyKey: "k-stop" }),
  }).then((response) => response.status, (error: unknown) => `error ${(error as { code?: string })?.code ?? "unknown"}`);
  await within(stderr.seen("[fake] tx begin k-stop"), 10_000, "transaction begin");
  return { child, stderr, status };
}

const events = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("[")).map((line) => line.trim());

function expectFakeSqlAndCommitBeforeClose(log: string[]) {
  // The fake SQL replaced Bun's SQL: both pools were fake, and no real client was created.
  expect(log).toContain("[fake] sql open admin");
  expect(log).toContain("[fake] sql open runtime");
  const commit = log.indexOf("[fake] tx commit k-stop");
  const close = log.indexOf("[fake] sql close runtime");
  expect(commit).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(commit);
}

test("stop() lets an in-flight command commit and reply 201 before the pool closes", async () => {
  const { dir, env } = await setup();
  const child = Bun.spawn([process.execPath, "--preload", preload, join(fixtures, "central-shutdown-driver.ts")], { env, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  try {
    const code = await within(child.exited, 10_000, "driver exit");
    const log = events(await new Response(child.stderr).text());
    expect(code).toBe(0);
    expect(log).toContain("[driver] client status 201");
    expect(log.indexOf("[driver] stop resolved")).toBeGreaterThan(log.indexOf("[fake] sql close runtime"));
    expectFakeSqlAndCommitBeforeClose(log);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("stop() force-closes after the grace deadline but still waits for SQL work before closing the pool", async () => {
  const { dir, env } = await setup();
  const child = Bun.spawn([process.execPath, "--preload", preload, join(fixtures, "central-shutdown-driver.ts"), "50"], { env, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  try {
    const code = await within(child.exited, 10_000, "driver exit");
    const log = events(await new Response(child.stderr).text());
    expect(code).toBe(0);
    // The client loses its connection: the committed outcome is unknown to it.
    expect(log.some((line) => line.startsWith("[driver] client error"))).toBe(true);
    expectFakeSqlAndCommitBeforeClose(log);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("SIGTERM on the CLI entry drains an in-flight command, replies 201 and exits cleanly", async () => {
  const { dir, env } = await setup();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const started = await startCli(env);
    child = started.child;
    child.kill("SIGTERM");
    expect(await within(started.status, 10_000, "client response")).toBe(201);
    const code = await within(child.exited, 10_000, "child exit");
    expect(child.signalCode).toBeNull();
    expect(code).toBe(0);
    const text = await within(started.stderr.done, 5_000, "child stderr");
    expect(text).not.toContain(operatorToken);
    expectFakeSqlAndCommitBeforeClose(events(text));
  } finally {
    child?.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("a second SIGTERM during the drain falls back to the default kill", async () => {
  const { dir, env } = await setup();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const started = await startCli({ ...env, FAKE_TX_MS: "5000" });
    child = started.child;
    child.kill("SIGTERM");
    // The first handler removes both listeners synchronously; give it time to run.
    await Bun.sleep(300);
    child.kill("SIGTERM");
    await within(child.exited, 10_000, "child exit");
    expect(child.signalCode).toBe("SIGTERM");
    expect(await within(started.status, 5_000, "client response")).not.toBe(201);
    const text = await within(started.stderr.done, 5_000, "child stderr");
    expect(text).not.toContain("[fake] tx commit k-stop");
  } finally {
    child?.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
