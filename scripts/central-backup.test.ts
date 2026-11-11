import { test, expect } from "bun:test";
import { mkdtemp, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "central-backup.ts");

test("backup requires an explicit target and never overwrites an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "central-backup-"));
  try {
    const marker = join(dir, "called");
    const executable = join(dir, "pg_dump");
    await writeFile(executable, '#!/bin/sh\n[ -z "$CENTRAL_BACKUP_URL" ] || exit 7\nprintf called > "$MARKER"\nprintf archive\nprintf "%s" "$PGPASSWORD" >&2\n');
    await chmod(executable, 0o700);
    const output = join(dir, "backup.dump");
    const secret = "secret-do-not-log";
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, MARKER: marker, CENTRAL_BACKUP_URL: `postgresql://tester:${secret}@localhost/testdb` };
    const run = async (args: string[], overrides: Record<string, string | undefined> = {}) => {
      const child = Bun.spawn([process.execPath, script, ...args], { env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
      return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
    };
    expect((await run([output], { CENTRAL_BACKUP_URL: "" })).code).not.toBe(0);
    expect((await run([output], { CENTRAL_BACKUP_URL: "postgresql://localhost/postgresql%3A%2F%2Fother%2Fdb" })).code).not.toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
    const success = await run([output]);
    expect(success.code).toBe(0);
    expect(success.stdout + success.stderr).not.toContain(secret);
    expect(await readFile(output, "utf8")).toBe("archive");
    await rm(marker);
    expect((await run([output])).code).not.toBe(0);
    expect(await readFile(output, "utf8")).toBe("archive");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
