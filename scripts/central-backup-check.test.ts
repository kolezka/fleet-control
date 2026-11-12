import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "central-backup-check.ts");

// A fake pg_restore that accepts only stdin starting with PGDMP and prints a TOC header.
const fake = [
  "#!/bin/sh",
  '[ "$1" = "--list" ] || exit 9',
  '[ -z "$PGHOST" ] || exit 8',
  "head=$(head -c 5)",
  '[ "$head" = "PGDMP" ] || exit 1',
  "cat >/dev/null",
  "printf ';\\n;     dbname: fleet_control_test\\n;     TOC Entries: 12\\n;     Format: %s\\n;\\n' \"${FAKE_FORMAT:-CUSTOM}\"",
  "",
].join("\n");

test("archive check lists the table of contents read-only and reports a checksum", async () => {
  const prefix = join(tmpdir(), "central-backup-check-");
  const dir = await mkdtemp(prefix);
  try {
    await writeFile(join(dir, "pg_restore"), fake);
    await chmod(join(dir, "pg_restore"), 0o700);
    const archive = join(dir, "good.dump");
    const content = "PGDMP" + "x".repeat(200000);
    await writeFile(archive, content);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGHOST: "must-be-dropped" };
    const run = async (args: string[], extra: Record<string, string> = {}) => {
      const child = Bun.spawn([process.execPath, script, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
      return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
    };
    const ok = await run([archive]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, tocEntries: 12, dbname: "fleet_control_test" });

    await writeFile(join(dir, "bad.dump"), "not an archive");
    await writeFile(join(dir, "empty.dump"), "");
    await symlink(archive, join(dir, "link.dump"));
    for (const bad of ["bad.dump", "empty.dump", "link.dump", "missing.dump", "."]) {
      const result = await run([join(dir, bad)]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }
    expect((await run([archive], { FAKE_FORMAT: "TAR" })).code).toBe(1);
    expect((await run([])).code).toBe(2);
    expect((await run([archive, archive])).code).toBe(2);
  } finally {
    if (dir.startsWith(prefix)) await rm(dir, { recursive: true, force: true });
  }
});
