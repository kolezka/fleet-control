// The file editor: an operator reads a folder or a text file inside the folders this host allows, and saves a
// file only with the revision it read and its name typed. Every save keeps a backup of the old text.
import { createHash } from "node:crypto";
import { AdminError } from "../domain/fleet-admin.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";
import { checkFileSave, checkPath, MAX_ENTRIES, NEW_FILE, refuseProtected, rootOf, type DirView, type FileEntry, type FileView } from "../domain/files.ts";

// links: hard links to the file; above 1 the same bytes may also be a protected file somewhere else.
export type HostEntry = { kind: "file" | "dir" | "other"; size: number; modifiedAt: string; links?: number };

// What the host does on disk. Paths given to it are already checked against the allowed folders, but the
// host resolves symlinks itself and answers with the real path, which is checked again here.
export type FilesHost = {
  // The real path with symlinks resolved; for a path that does not exist yet, its folder resolved plus its
  // name. null when the folder does not exist either.
  real(path: string): Promise<string | null>;
  stat(path: string): Promise<HostEntry | null>;
  list(dir: string): Promise<{ name: string; entry: HostEntry }[]>;
  // The text, or an AdminError when it is too big or not UTF-8 text.
  read(path: string): Promise<string>;
  // Writes text if the file still holds `expected` (null: does not exist yet). Returns the backup path
  // (null for a new file), or throws AdminError conflict when the file changed.
  write(path: string, expected: string | null, text: string): Promise<string | null>;
};

export type FilesDeps = {
  host: FilesHost;
  roots: readonly string[];
  // Files and folders the editor never touches here: tokens, settings, fleet.conf and the like.
  protectedPaths: readonly string[];
};

export const fileRevision = (text: string) => createHash("sha256").update(text).digest("hex");

let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
};

export function filesUseCases(deps: FilesDeps, caller?: Caller) {
  // Roots and protected paths are compared after symlinks are resolved on both sides, so a symlinked or
  // differently written folder (/tmp vs /private/tmp, FLEET.CONF vs fleet.conf on macOS) cannot slip past.
  const resolved = async (paths: readonly string[]) => (await Promise.all(paths.map(async (p) => [p, await deps.host.real(p)] as const)));
  const allowed = async (path: string) => {
    const asked = checkPath(path);
    const rootPairs = await resolved(deps.roots);
    const roots = rootPairs.flatMap(([p, r]) => (r === null ? [] : r === p ? [p] : [p, r]));
    const realRoots = rootPairs.map(([, r]) => r).filter((r): r is string => r !== null);
    rootOf(asked, roots);
    const real = await deps.host.real(asked);
    if (real === null) throw new AdminError("not_found", `${asked} does not exist, nor does its folder`);
    // A symlink may lead out of the folder; what counts is where it leads.
    const root = rootOf(real, realRoots);
    const guarded = (await resolved(deps.protectedPaths)).flatMap(([p, r]) => (r === null ? [p] : [p, r]));
    refuseProtected(real, guarded);
    return { asked, real, root };
  };
  const single = (real: string, st: HostEntry) => {
    if (st.kind === "file" && (st.links ?? 1) > 1) throw new AdminError("invalid", `${real} has ${st.links} hard links; one of them may be a file this editor must not touch, so it does not open it`);
  };

  return {
    roots: () => {
      requirePermission(caller, "operate");
      return { roots: [...deps.roots] };
    },

    async open(path: string): Promise<DirView | FileView> {
      requirePermission(caller, "operate");
      const { asked, real, root } = await allowed(path);
      const st = await deps.host.stat(real);
      if (!st) throw new AdminError("not_found", `${asked} does not exist`);
      if (st.kind === "dir") {
        const listed = await deps.host.list(real);
        const entries: FileEntry[] = listed
          .map(({ name, entry }) => ({ name, ...entry }))
          .sort((a, b) => (a.kind === "dir") === (b.kind === "dir") ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1);
        return { kind: "dir", path: real, root, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
      }
      if (st.kind !== "file") throw new AdminError("invalid", `${asked} is not a regular file or a folder`);
      single(real, st);
      const text = await deps.host.read(real);
      return { kind: "file", path: real, root, text, revision: fileRevision(text), size: st.size };
    },

    save: (input: unknown) => serial(async () => {
      requirePermission(caller, "operate");
      const s = checkFileSave(input);
      const { real } = await allowed(s.path);
      const st = await deps.host.stat(real);
      if (s.revision === NEW_FILE) {
        if (st) throw new AdminError("conflict", `${real} already exists; open it and edit it instead`);
        const parent = real.slice(0, real.lastIndexOf("/")) || "/";
        const ps = await deps.host.stat(parent);
        if (!ps || ps.kind !== "dir") throw new AdminError("not_found", `the folder ${parent} does not exist`);
        await deps.host.write(real, null, s.text);
        return { path: real, revision: fileRevision(s.text), backup: null };
      }
      if (!st) throw new AdminError("conflict", `${real} is gone since you read it`);
      if (st.kind !== "file") throw new AdminError("invalid", `${real} is not a regular file`);
      single(real, st);
      const current = await deps.host.read(real);
      if (fileRevision(current) !== s.revision) throw new AdminError("conflict", `${real} changed on the host since you read it; reload it and edit again`);
      if (current === s.text) return { path: real, revision: s.revision, backup: null };
      const backup = await deps.host.write(real, current, s.text);
      return { path: real, revision: fileRevision(s.text), backup };
    }),
  };
}

export type FilesUseCases = ReturnType<typeof filesUseCases>;
