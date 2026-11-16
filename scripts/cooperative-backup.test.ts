import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { centralTestDatabaseUrl } from "../src/central/test-database-url.ts";

// Runs the real deploy/cooperative/backup.sh against the disposable local PostgreSQL fixture.
// Skipped unless CENTRAL_TEST_DATABASE_URL is set.
const url = centralTestDatabaseUrl(process.env);
const container = "fleet-control-central-test";
const deployDir = join(import.meta.dir, "../deploy/cooperative");
const schema = "fleet_cooperative_v1";

// Stands in for "docker compose exec -T postgres <cmd>": runs <cmd> in the fixture container.
// Database "fleet" becomes the test's own database, so the script needs no test switch.
// FAKE_AFTER_RESTORE is SQL run in the throwaway database between restore and comparison.
const fakeDocker = [
  "#!/bin/sh",
  '[ "$1 $2 $3 $4" = "compose exec -T postgres" ] || exit 9',
  "shift 4",
  "tool=$1 target= previous= count=$#",
  'while [ "$count" -gt 0 ]; do',
  "  arg=$1; shift; count=$((count - 1))",
  '  if [ "$previous" = -d ]; then',
  '    [ "$arg" = fleet ] && arg=$FAKE_DATABASE',
  "    target=$arg",
  "  fi",
  '  set -- "$@" "$arg"; previous=$arg',
  "done",
  'printf \'%s\\n\' "$*" >> "$FAKE_LOG"',
  '"$FAKE_DOCKER" exec -i "$FAKE_CONTAINER" "$@" || exit $?',
  'if [ "$tool" = pg_restore ] && [ -n "$target" ] && [ -n "$FAKE_AFTER_RESTORE" ]; then',
  '  "$FAKE_DOCKER" exec -i "$FAKE_CONTAINER" psql -U postgres -d "$target" -XAtq -v ON_ERROR_STOP=1 -c "$FAKE_AFTER_RESTORE" > /dev/null || exit 7',
  "fi",
  "",
].join("\n");

type Fixture = {
  database: string;
  /** Values stored in rows. None of them may show up in the script output. */
  cells: string[];
  run: (afterRestore?: string) => Promise<{ code: number; output: string; log: string }>;
  /** What an operator gets with psql alone: the last line of schema-fingerprint.sql. */
  fingerprint: () => Promise<string>;
};

async function withLiveDatabase(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const docker = Bun.which("docker");
  if (!docker) throw new Error("docker is not on PATH");
  const admin = new SQL(url!, { max: 1 });
  const names = async (query: string) => (await admin.unsafe(query)).map((row: { name: string }) => row.name);
  const databases = () => names("SELECT datname AS name FROM pg_database ORDER BY 1");
  const schemas = () => names("SELECT nspname AS name FROM pg_namespace ORDER BY 1");
  const database = "backup_test_" + randomBytes(6).toString("hex");
  const cells = [0, 1, 2, 3].map(() => "cell-" + randomBytes(8).toString("hex"));
  const prefix = join(tmpdir(), "cooperative-backup-");
  const dir = await mkdtemp(prefix);
  const before = { databases: await databases(), schemas: await schemas() };
  let after: typeof before | undefined;
  let live: SQL | undefined;
  try {
    await admin.unsafe('CREATE DATABASE "' + database + '"');
    // The restored copy does not get these settings. Digests must not depend on them.
    await admin.unsafe('ALTER DATABASE "' + database + "\" SET TimeZone = 'Asia/Tokyo'");
    await admin.unsafe('ALTER DATABASE "' + database + "\" SET DateStyle = 'German, DMY'");
    live = new SQL(url!.replace(/\/fleet_control_test$/, "/" + database), { max: 1 });
    await live.unsafe([
      "CREATE SCHEMA " + schema,
      "CREATE TABLE " + schema + ".commands (id text PRIMARY KEY, payload text, note text)",
      "CREATE TABLE " + schema + ".events (seq int PRIMARY KEY, body jsonb NOT NULL, at timestamptz NOT NULL)",
      "INSERT INTO " + schema + ".commands VALUES ('c1', '" + cells[0] + "', NULL), ('c2', '" + cells[1] + "', '')",
      "INSERT INTO " + schema + ".events VALUES (1, '{\"detail\": \"" + cells[2] + "\"}', '2026-11-15T10:00:00Z')",
      "CREATE INDEX events_at ON " + schema + ".events (at)",
      "CREATE SEQUENCE " + schema + ".ids",
      "SELECT setval('" + schema + ".ids', 41)",
    ].join("; "));
    const rows = async () => [
      await live!.unsafe("SELECT * FROM " + schema + ".commands ORDER BY id"),
      await live!.unsafe("SELECT * FROM " + schema + ".events ORDER BY seq"),
    ];
    await writeFile(join(dir, "docker"), fakeDocker);
    await chmod(join(dir, "docker"), 0o700);
    const env = { ...process.env, PATH: dir + ":" + process.env.PATH, FAKE_DOCKER: docker, FAKE_CONTAINER: container, FAKE_DATABASE: database };
    let runs = 0;
    const run = async (afterRestore = "") => {
      const log = join(dir, "log-" + ++runs);
      const child = Bun.spawn(["bash", join(deployDir, "backup.sh"), join(dir, "archive-" + runs + ".dump"), "--check-restore"], {
        env: { ...env, FAKE_LOG: log, FAKE_AFTER_RESTORE: afterRestore }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, output: stdout + stderr, log: await Bun.file(log).text() };
    };
    const fingerprint = async () => {
      const child = Bun.spawn([docker, "exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", database],
        { stdin: Bun.file(join(deployDir, "schema-fingerprint.sql")), stdout: "pipe", stderr: "pipe" });
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(code).toBe(0);
      return stdout.trimEnd().split("\n").at(-1)!;
    };
    const rowsBefore = await rows();
    await body({ database, cells, run, fingerprint });
    // The script only read the live database and dropped its own throwaway database.
    expect(await rows()).toEqual(rowsBefore);
    expect(await databases()).toEqual([...before.databases, database].sort());
  } finally {
    await live?.close();
    await admin.unsafe('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
    if (dir.startsWith(prefix)) await rm(dir, { recursive: true, force: true });
    after = { databases: await databases(), schemas: await schemas() };
    await admin.close();
  }
  // Nothing of this test is left: no database, and no schema in fleet_control_test.
  expect(after).toEqual(before);
}

const scratchOf = (log: string) => /^createdb -U postgres (restore_check_[0-9a-f]{12})$/m.exec(log)?.[1];

test.skipIf(!url)("identical restore passes and prints the fingerprint psql gives for the same data", async () => {
  await withLiveDatabase(async ({ cells, run, fingerprint }) => {
    const result = await run();
    expect(result.output).toContain("restore check ok: 2 tables, row counts and contents equal to the live database");
    expect(result.code).toBe(0);
    const printed = /^restored fingerprint ([0-9a-f]{64}) /m.exec(result.output)?.[1];
    expect(await fingerprint()).toBe("fingerprint " + printed);
    for (const cell of cells) expect(result.output).not.toContain(cell);
    expect(scratchOf(result.log)).toBeDefined();
    expect(result.output).toMatch(/^restored definition [0-9a-f]{64} schema fleet_cooperative_v1$/m);
  });
}, 60_000);

test.skipIf(!url)("one changed cell with the same row count exits 3 and names the table", async () => {
  await withLiveDatabase(async ({ cells, run, fingerprint }) => {
    const result = await run("UPDATE " + schema + ".commands SET payload = '" + cells[3] + "' WHERE id = 'c1'");
    expect(result.code).toBe(3);
    const summary = result.output.split("\n").find((line) => line.startsWith("restore check: 2 tables restored"));
    expect(summary).toContain("differ from live in: commands (writes since the dump?)");
    // Both sides have two rows; only the digest tells them apart.
    const detail = result.output.split("\n").filter((line) => /^ {2}(live|restored) /.test(line));
    expect(detail.map((line) => line.replace(/[0-9a-f]{64}$/, "<digest>"))).toEqual(["  live     commands 2 <digest>", "  restored commands 2 <digest>"]);
    expect(detail[0]!.slice(-64)).not.toBe(detail[1]!.slice(-64));
    // The fingerprint is of the restored copy, so it is not the live one here.
    const printed = /^restored fingerprint ([0-9a-f]{64}) /m.exec(result.output)?.[1];
    expect(printed).toBeDefined();
    expect(await fingerprint()).not.toBe("fingerprint " + printed);
    for (const cell of cells) expect(result.output).not.toContain(cell);
  });
}, 60_000);

test.skipIf(!url)("a different row count still exits 3", async () => {
  await withLiveDatabase(async ({ cells, run }) => {
    const result = await run("DELETE FROM " + schema + ".commands WHERE id = 'c2'");
    expect(result.code).toBe(3);
    expect(result.output).toContain("differ");
    expect(result.output).toContain("commands 2");
    expect(result.output).toContain("commands 1");
    for (const cell of cells) expect(result.output).not.toContain(cell);
  });
}, 60_000);

test.skipIf(!url)("equal rows but a lost index or sequence value exits 3 and names the definition", async () => {
  for (const [change, live, restored] of [
    ["DROP INDEX " + schema + ".events_at", "  live     index CREATE INDEX events_at", undefined],
    ["SELECT setval('" + schema + ".ids', 7)", "  live     sequence ids bigint increment 1 last 41", "  restored sequence ids bigint increment 1 last 7"],
  ] as const) {
    await withLiveDatabase(async ({ cells, run }) => {
      const result = await run(change);
      expect(result.code).toBe(3);
      expect(result.output).toContain("restore check: definitions differ from live");
      expect(result.output).not.toContain("restore check ok");
      const lines = result.output.split("\n");
      expect(lines.some((line) => line.startsWith(live))).toBe(true);
      if (restored) expect(lines).toContain(restored);
      for (const cell of cells) expect(result.output).not.toContain(cell);
    });
  }
}, 120_000);
