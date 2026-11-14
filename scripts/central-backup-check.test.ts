import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "central-backup-check.ts");

// A fake pg_restore that accepts only stdin starting with PGDMP. With --list it prints a TOC header.
// With --file=/dev/null it stands in for the full read: like the real tool, it fails on input cut short.
const fake = [
  "#!/bin/sh",
  '[ "$#" -eq 1 ] || exit 9',
  'case "$1" in --list) mode=list ;; --file=/dev/null) mode=data ;; *) exit 9 ;; esac',
  '[ -z "$PGHOST" ] || exit 8',
  '[ -z "$GROW" ] || printf more >> "$GROW"',
  'cat > "$CAPTURE.$mode"',
  '[ "$(head -c 5 "$CAPTURE.$mode")" = "PGDMP" ] || exit 1',
  'if [ "$mode" = data ]; then [ "$(tail -c 3 "$CAPTURE.data")" = "END" ] || exit 5; exit 0; fi',
  '[ -z "$FAKE_FAIL" ] || exit 3',
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
    const content = "PGDMP" + "x".repeat(200000) + "END";
    await writeFile(archive, content);
    const capture = join(dir, "capture");
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGHOST: "must-be-dropped", CAPTURE: capture };
    const run = async (args: string[], extra: Record<string, string> = {}) => {
      const child = Bun.spawn([process.execPath, script, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
      return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
    };
    const ok = await run([archive]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, tocEntries: 12, dbname: "fleet_control_test" });
    // Both pg_restore passes received exactly the bytes that were hashed.
    expect(await Bun.file(capture + ".list").text()).toBe(content);
    expect(await Bun.file(capture + ".data").text()).toBe(content);

    // The table of contents still lists, but the data section is cut short.
    const cut = join(dir, "cut.dump");
    await writeFile(cut, content.slice(0, -3));
    const truncated = await run([cut]);
    expect(truncated.code).toBe(1);
    expect(truncated.stdout).toBe("");
    expect(await Bun.file(capture + ".list").text()).toBe(content.slice(0, -3));
    expect(await Bun.file(capture + ".data").text()).toBe(content.slice(0, -3));

    await writeFile(join(dir, "bad.dump"), "not an archive");
    await writeFile(join(dir, "empty.dump"), "");
    await symlink(archive, join(dir, "link.dump"));
    for (const bad of ["bad.dump", "empty.dump", "link.dump", "missing.dump", "."]) {
      const result = await run([join(dir, bad)]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }
    expect((await run([archive], { FAKE_FORMAT: "TAR" })).code).toBe(1);
    expect((await run([archive], { FAKE_FAIL: "1" })).code).toBe(1);
    // A file that grows while being checked (for example a running pg_dump) is rejected.
    const growing = join(dir, "growing.dump");
    await writeFile(growing, content);
    const grown = await run([growing], { GROW: growing });
    expect(grown.code).toBe(1);
    expect(grown.stdout).toBe("");
    const fifo = join(dir, "fifo.dump");
    expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
    expect((await run([fifo])).code).toBe(1);
    // No pg_restore on PATH at all.
    expect((await run([archive], { PATH: "/nonexistent" })).code).toBe(1);
    expect((await run([])).code).toBe(2);
    expect((await run([archive, archive])).code).toBe(2);
  } finally {
    if (dir.startsWith(prefix)) await rm(dir, { recursive: true, force: true });
  }
});
