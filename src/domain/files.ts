// Rules for editing text files on a host from the page: only inside the folders the host allows, only
// small UTF-8 text, only with the revision the page read and the file name typed to confirm.
import { AdminError } from "./fleet-admin.ts";

// Small enough to pass the gateway's 64 KiB request cap as JSON, big enough for a config or a prompt.
export const MAX_FILE_BYTES = 32 * 1024;
export const MAX_PATH = 1024;
export const MAX_ENTRIES = 500;
export const FILE_ROOT = /^\/[A-Za-z0-9._\/-]+$/;
// A new file has no revision yet; the page sends this one for it.
export const NEW_FILE = "new";
const REVISION = /^[0-9a-f]{64}$/;

export type FileEntry = { name: string; kind: "file" | "dir" | "other"; size: number; modifiedAt: string };
export type DirView = { kind: "dir"; path: string; root: string; entries: FileEntry[]; truncated: boolean };
export type FileView = { kind: "file"; path: string; root: string; text: string; revision: string; size: number };
export type FileSave = { path: string; text: string; revision: string; confirm: string };

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// An absolute path in plain form: no empty, "." or ".." segments, no control characters. The host still
// resolves symlinks before it trusts the folder.
export function checkPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) throw new AdminError("invalid", "path must be an absolute path");
  if (path.length > MAX_PATH) throw new AdminError("invalid", `path is longer than ${MAX_PATH} characters`);
  if (!path.startsWith("/")) throw new AdminError("invalid", "path must be an absolute path");
  if (CONTROL.test(path) || path.includes("\n") || path.includes("\r") || path.includes("\t")) throw new AdminError("invalid", "path must not contain control characters");
  const parts = path.split("/").slice(1);
  const trimmed = parts.length > 1 && parts.at(-1) === "" ? parts.slice(0, -1) : parts;
  if (trimmed.some((p) => p === "" || p === "." || p === "..")) throw new AdminError("invalid", "path must be plain: no empty, . or .. parts");
  return "/" + trimmed.join("/");
}

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/");

// The allowed folder that holds this path, or a refusal that names the allowed folders.
export function rootOf(path: string, roots: readonly string[]): string {
  const hit = roots.filter((r) => inside(path, r)).sort((a, b) => b.length - a.length)[0];
  if (!hit) throw new AdminError("invalid", `${path} is outside the folders this host allows (${roots.join(", ") || "none"})`);
  return hit;
}

// Files the page never edits here even inside an allowed folder: the service's own secrets and settings,
// and fleet.conf, which has its own editor with its own checks.
// Names refused anywhere: an orchestrator's MCP config holds its token, and token files hold tokens.
export const PROTECTED_NAME = /^(fc-[a-z0-9-]+\.mcp\.json|tokens|tokens\.lock|token-.+|settings\.json)$/;
export function refuseProtected(path: string, protectedPaths: readonly string[]): void {
  const refuse = () => { throw new AdminError("invalid", `${path} belongs to the Fleet Control service; this editor does not change it`); };
  for (const p of protectedPaths) if (path === p || inside(path, p)) refuse();
  if (PROTECTED_NAME.test(basename(path))) refuse();
}

export function checkText(text: unknown): string {
  if (typeof text !== "string") throw new AdminError("invalid", "text must be a string");
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) throw new AdminError("invalid", `the text is over ${MAX_FILE_BYTES / 1024} KiB`);
  if (text.includes("\0")) throw new AdminError("invalid", "the text contains a NUL byte; this editor keeps to text files");
  return text;
}

export function checkFileSave(input: unknown): FileSave {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError("invalid", "body must be an object");
  const o = input as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["path", "text", "revision", "confirm"].includes(k));
  if (extra.length) throw new AdminError("invalid", `unknown field ${extra[0]}`);
  const path = checkPath(o.path);
  const text = checkText(o.text);
  if (typeof o.revision !== "string" || !(o.revision === NEW_FILE || REVISION.test(o.revision))) throw new AdminError("invalid", `revision must be the 64-hex revision the file was read at, or ${NEW_FILE} for a new file`);
  const name = basename(path);
  if (o.confirm !== name) throw new AdminError("invalid", `type ${name} to confirm`);
  return { path, text, revision: o.revision, confirm: name };
}
