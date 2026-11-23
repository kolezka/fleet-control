// The file editor's disk side. A save keeps the old text as <name>.bak-<stamp>-<id> beside the file with the
// same mode, writes a temp file, looks once more that nobody changed the file, and renames.
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AdminError } from "../domain/fleet-admin.ts";
import { MAX_FILE_BYTES } from "../domain/files.ts";
import type { FilesHost, HostEntry } from "../application/files.ts";

const kindOf = (s: { isFile(): boolean; isDirectory(): boolean }): HostEntry["kind"] => (s.isFile() ? "file" : s.isDirectory() ? "dir" : "other");
const missing = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "");

export class DiskFiles implements FilesHost {
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
      return { kind: kindOf(s), size: s.size, modifiedAt: s.mtime.toISOString() };
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

  async read(path: string) {
    const s = await stat(path);
    if (s.size > MAX_FILE_BYTES) throw new AdminError("invalid", `${path} is ${Math.ceil(s.size / 1024)} KiB; this editor opens files up to ${MAX_FILE_BYTES / 1024} KiB`);
    const bytes = await readFile(path);
    if (bytes.includes(0)) throw new AdminError("invalid", `${path} is not a text file (it has NUL bytes)`);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
      throw new AdminError("invalid", `${path} is not UTF-8 text`);
    }
  }

  async write(path: string, expected: string | null, text: string) {
    const dir = dirname(path);
    const name = basename(path);
    const now = async () => { try { return await readFile(path, "utf8"); } catch (e) { if (missing(e)) return null; throw e; } };
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
    await copyFile(path, backup);
    const tmp = join(dir, `.${name}.new-${randomUUID()}`);
    try {
      const fh = await open(tmp, "wx", mode);
      try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
      await chmod(tmp, mode);
      if ((await now()) !== expected) throw new AdminError("conflict", `${path} changed on the host during the save; nothing was written. Reload it and edit again`);
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      await rm(backup, { force: true });
      throw e;
    }
    return backup;
  }
}
