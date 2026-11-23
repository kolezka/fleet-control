// The file editor's disk side. A save keeps the old text as <name>.bak-<stamp>-<id> beside the file with the
// same mode, writes a temp file, looks once more that nobody changed the file, and renames.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AdminError } from "../domain/fleet-admin.ts";
import { MAX_FILE_BYTES } from "../domain/files.ts";
import type { FilesHost, HostEntry } from "../application/files.ts";

const kindOf = (s: { isFile(): boolean; isDirectory(): boolean }): HostEntry["kind"] => (s.isFile() ? "file" : s.isDirectory() ? "dir" : "other");
const tooBig = (path: string, size: number, more = false) => new AdminError("invalid", `${path} is ${Math.ceil(size / 1024)} KiB${more ? " or more" : ""}; this editor opens files up to ${MAX_FILE_BYTES / 1024} KiB`);
// ignoreBOM keeps a leading byte order mark in the text, so it is shown, compared and written back as it was.
function decode(path: string, bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new AdminError("invalid", `${path} is not a text file (it has NUL bytes)`);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch {
    throw new AdminError("invalid", `${path} is not UTF-8 text`);
  }
}
const missing = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "");

// Test seams: run between the size check and the read, and just before the rename, so a race can be staged.
export type DiskHooks = { afterSize?: (path: string) => Promise<void>; beforeBackup?: (path: string) => Promise<void>; afterBackup?: (path: string) => Promise<void>; beforeRename?: (path: string) => Promise<void> };

export class DiskFiles implements FilesHost {
  readonly #hooks: DiskHooks;
  constructor(hooks: DiskHooks = {}) { this.#hooks = hooks; }
  async real(path: string) {
    try { return await realpath(path); } catch (e) {
      if (!missing(e)) throw e;
    }
    // Not there yet: its folder must exist, and the name is taken as typed.
    try { return join(await realpath(dirname(path)), basename(path)); } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  }

  async stat(path: string): Promise<HostEntry | null> {
    try {
      const s = await stat(path);
      return { kind: kindOf(s), size: s.size, modifiedAt: s.mtime.toISOString(), links: s.nlink };
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  }

  async list(dir: string) {
    const names = await readdir(dir);
    const out: { name: string; entry: HostEntry }[] = [];
    for (const name of names) {
      try {
        // lstat: a symlink in the list shows as "other" until it is opened, then it is resolved and checked.
        const s = await lstat(join(dir, name));
        out.push({ name, entry: { kind: s.isSymbolicLink() ? "other" : kindOf(s), size: s.size, modifiedAt: s.mtime.toISOString() } });
      } catch (e) {
        if (!missing(e)) throw e;
      }
    }
    return out;
  }

  // One handle, opened without following a symlink, gives the size check, the bytes and the decode, so a path
  // swapped for a link after the checks is refused, and a file that grows meanwhile is not read whole.
  async #bytes(path: string): Promise<Uint8Array> {
    const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new AdminError("conflict", `${path} became a symlink after it was checked; open it again`);
      throw e;
    });
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new AdminError("invalid", `${path} is not a regular file`);
      if (st.nlink > 1) throw new AdminError("invalid", `${path} has ${st.nlink} hard links; one of them may be a file this editor must not touch, so it does not open it`);
      if (st.size > MAX_FILE_BYTES) throw tooBig(path, st.size);
      await this.#hooks.afterSize?.(path);
      const buf = new Uint8Array(MAX_FILE_BYTES + 1);
      let got = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
        if (got > MAX_FILE_BYTES) throw tooBig(path, got, true);
      }
      return buf.subarray(0, got);
    } finally { await fh.close(); }
  }

  async read(path: string) {
    return decode(path, await this.#bytes(path));
  }

  async write(path: string, expected: string | null, text: string) {
    const dir = dirname(path);
    const name = basename(path);
    const now = async () => { try { return decode(path, await this.#bytes(path)); } catch (e) { if (missing(e)) return null; throw e; } };
    // The folder must still be the one that was checked; a folder swapped for a symlink would send the write elsewhere.
    const sameFolder = async () => {
      if ((await realpath(dir)) !== dir) throw new AdminError("conflict", `the folder of ${path} changed on the host during the save; nothing was written. Reload it and edit again`);
    };
    await sameFolder();
    if (expected === null) {
      // A new file: "wx" refuses one that appeared meanwhile.
      const fh = await open(path, "wx", 0o600).catch((e) => {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new AdminError("conflict", `${path} appeared on the host meanwhile; open it and edit it instead`);
        throw e;
      });
      try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
      return null;
    }
    const mode = (await stat(path)).mode & 0o777;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const backup = join(dir, `${name}.bak-${stamp}-${randomUUID().slice(0, 8)}`);
    const tmp = join(dir, `.${name}.new-${randomUUID()}`);
    try {
      // The backup holds the bytes just read through the no-follow handle, not a copy of whatever the path names now.
      const old = await this.#bytes(path);
      if (decode(path, old) !== expected) throw new AdminError("conflict", `${path} changed on the host during the save; nothing was written. Reload it and edit again`);
      await this.#hooks.beforeBackup?.(path);
      const bh = await open(backup, "wx", mode);
      try { await bh.writeFile(old); await bh.sync(); } finally { await bh.close(); }
      await chmod(backup, mode);
      await this.#hooks.afterBackup?.(path);
      const fh = await open(tmp, "wx", mode);
      try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
      await chmod(tmp, mode);
      if ((await now()) !== expected) throw new AdminError("conflict", `${path} changed on the host during the save; nothing was written. Reload it and edit again`);
      await this.#hooks.beforeRename?.(path);
      await sameFolder();
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      await rm(backup, { force: true });
      throw e;
    }
    return backup;
  }
}
