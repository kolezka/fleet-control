import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs startup in a child under the fake preload, so no real SQL client exists.
const preload = join(import.meta.dir, "test-fixtures", "central-shutdown-preload.ts");
const main = join(import.meta.dir, "cooperative-main.ts");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const credentials = JSON.stringify([
  { tokenHash: hash("operator-token"), principal: { name: "op", role: "operator" } },
  { tokenHash: hash("supervisor-token"), principal: { name: "sup", role: "supervisor", principalId: "p1", hostId: "h1", session: "s1" } },
]);

async function start(dir: string, credentialsFile: string) {
  const script = join(dir, "start.ts");
  await writeFile(script, `import { startCooperative } from ${JSON.stringify(main)};
try { const running = await startCooperative(process.env); console.error("[child] started"); await running.stop(); }
catch (error) { console.error("[child] rejected " + (error as Error).message); }`);
  const child = Bun.spawn([process.execPath, "--preload", preload, script], {
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_TX_MS: "0",
      COOPERATIVE_DATABASE_URL: "postgres://test@127.0.0.1:57507/fleet_control_test",
      COOPERATIVE_RUNTIME_DATABASE_URL: `postgres://cooperative_runtime_${"a".repeat(32)}@127.0.0.1:57507/fleet_control_test`,
      COOPERATIVE_SCHEMA: `cooperative_test_${"b".repeat(32)}`,
      COOPERATIVE_CREDENTIALS_FILE: credentialsFile,
      COOPERATIVE_INCARNATION_FILE: join(dir, "incarnation.json"),
      COOPERATIVE_PORT: "0",
    },
    stdout: "ignore", stderr: "pipe", stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const text = await new Response(child.stderr).text();
    await child.exited;
    return text;
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

test("credentials must be a private regular file owned by the current user, checked before any SQL client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-central-credentials-"));
  try {
    const open = join(dir, "open.json");
    await writeFile(open, credentials, { mode: 0o600 });
    await chmod(open, 0o640);
    const link = join(dir, "link.json");
    const target = join(dir, "target.json");
    await writeFile(target, credentials, { mode: 0o600 });
    await symlink(target, link);
    const relative = "credentials.json";
    for (const file of [open, link, relative, dir]) {
      const text = await start(dir, file);
      expect(text).toContain("[child] rejected invalid or unreadable cooperative credentials file");
      expect(text).not.toContain("[fake] sql open");
    }
    // Positive control: the same content in a private file gets past the check.
    const text = await start(dir, target);
    expect(text).toContain("[fake] sql open admin");
    expect(text).toContain("[child] started");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
