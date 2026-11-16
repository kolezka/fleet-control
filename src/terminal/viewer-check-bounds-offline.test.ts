import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openViewer, supportsReadOnlyAttach } from "./viewer.ts";

// The read-only check runs before every viewer; a CLI whose help hangs must not hold the upgrade.
const dir = await mkdtemp(join(tmpdir(), "viewer-check-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const stub = async (name: string, body: string) => {
  const bin = join(dir, name);
  await writeFile(bin, `#!/bin/sh\n${body}\n`);
  await chmod(bin, 0o700);
  return bin;
};

test("a hung help is killed and the viewer is refused", async () => {
  const bin = await stub("hang", "sleep 30");
  const started = Date.now();
  await expect(supportsReadOnlyAttach(bin, 300)).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("help on stderr still counts, and a CLI without the flag is refused", async () => {
  expect(await supportsReadOnlyAttach(await stub("err", 'echo "fleet attach [--read-only] <session>" >&2'))).toBe(true);
  const old = await stub("old", 'echo "fleet attach <session>"');
  expect(await supportsReadOnlyAttach(old)).toBe(false);
  await expect(openViewer({ fleetBin: old, confPath: "unused", session: "alpha", cols: 80, rows: 24, onData() {}, onExit() {} }))
    .rejects.toThrow("refusing a writable attach");
});
