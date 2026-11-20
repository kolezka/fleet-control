// Manage the host tokens file without hand edits: add, rotate, revoke, set a role, list.
// Usage: bun scripts/tokens.ts add <principal> <tokens-file> [operator|agent|viewer]
//        bun scripts/tokens.ts rotate|revoke <principal> <tokens-file>
//        bun scripts/tokens.ts role <principal> <operator|agent|viewer> <tokens-file>
//        bun scripts/tokens.ts list <tokens-file>
// A line without a role is an agent. Rotate keeps the role.
// The new token is printed once on stdout. The file is checked, then replaced atomically with mode 0600.
// The running service rereads the file on SIGHUP (releases before that only at start).
import { chmodSync, closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { AuthConfigError, newToken, parseTokens, tokenLine } from "../src/auth.ts";
import { isRole, ROLES, type Role } from "../src/domain/roles.ts";

export type Change = { action: "add" | "rotate" | "revoke" | "role"; name: string; token?: string; text: string };

const lineName = (raw: string) => {
  const line = raw.trim();
  return !line || line.startsWith("#") ? null : line.split(/\s+/)[0]!;
};

const checkRole = (role: string | undefined): Role | undefined => {
  if (role !== undefined && !isRole(role)) throw new AuthConfigError(`role must be one of ${ROLES.join(", ")}`);
  return role;
};
// The role column of an existing line, undefined for an old two-column line.
const lineRole = (raw: string): Role | undefined => checkRole(raw.trim().split(/\s+/)[2]);

// Pure: returns the new file text. Comments and order are kept; the result must parse.
// `role` is the role for add (none writes an old-style agent line) and the new role for "role".
// Managed agents' names (fc-...) carry only agent tokens; the service replaces and removes them on its own.
const MANAGED_NAME = /^fc-[a-z0-9][a-z0-9-]{0,30}$/;

export function change(action: Change["action"], name: string, text: string, token = newToken(), role?: string): Change {
  tokenLine(name, token); // validates the name
  const wanted = checkRole(role);
  if ((action === "add" || action === "role") && MANAGED_NAME.test(name) && wanted !== undefined && wanted !== "agent") {
    throw new AuthConfigError(`${name}: names starting with fc- are kept for managed agents and take only the agent role`);
  }
  if (action === "role" && !wanted) throw new AuthConfigError(`role must be one of ${ROLES.join(", ")}`);
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const at = lines.findIndex((l) => lineName(l) === name);
  if (action === "add") {
    if (at >= 0) throw new AuthConfigError(`${name} already has a token; use rotate`);
    lines.push(tokenLine(name, token, wanted));
  } else if (at < 0) {
    throw new AuthConfigError(`no principal ${name} in the tokens file`);
  } else if (action === "rotate") {
    lines[at] = tokenLine(name, token, lineRole(lines[at]!));
  } else if (action === "role") {
    const [n, hash] = lines[at]!.trim().split(/\s+/);
    lines[at] = `${n} ${hash} ${wanted}`;
  } else {
    lines.splice(at, 1);
  }
  const out = lines.length ? `${lines.join("\n")}\n` : "";
  parseTokens(out); // refuses an empty file, unknown roles and duplicate names or hashes, as the service would
  return { action, name, ...(action === "rotate" || action === "add" ? { token } : {}), text: out };
}

// Adds a line from a hash made elsewhere (the gateway keeps the token). The same line already
// present is a no-op, so pasting the command twice is safe; another hash for the name is refused.
export function addHash(text: string, name: string, hash: string, role: Role): { text: string; changed: boolean } {
  tokenLine(name, "", role); // validates name and role
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new AuthConfigError("hash must be 64 lowercase hex characters");
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const line = `${name} ${hash} ${role}`;
  const at = lines.findIndex((l) => lineName(l) === name);
  if (at >= 0) {
    if (lines[at]!.trim().split(/\s+/).join(" ") === line) return { text, changed: false };
    throw new AuthConfigError(`${name} already has a token here; choose another name, or revoke it first with bun scripts/tokens.ts revoke ${name} <tokens-file>`);
  }
  lines.push(line);
  const out = `${lines.join("\n")}\n`;
  parseTokens(out);
  return { text: out, changed: true };
}

// Two changes at once would each read the old file and the later rename would drop the other's
// principal, whose printed token then never works. A lock file next to the tokens file serialises them.
export const LOCK_WAIT_MS = 5000;

// Says whether the process named in the lock still runs. The lock is never removed here: two waiters
// clearing a stale lock at once could each delete the other's fresh one.
function holder(lock: string): string {
  let pid = NaN;
  try { pid = Number(readFileSync(lock, "utf8").trim()); } catch {}
  if (!Number.isSafeInteger(pid) || pid < 1) return "if no change is running, remove that file and retry";
  try { process.kill(pid, 0); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return `its process ${pid} is not running; remove that file and retry`;
  }
  return `process ${pid} holds it; wait for it to finish`;
}
export function withLock<T>(file: string, run: () => T, waitMs = LOCK_WAIT_MS): T {
  const lock = `${file}.lock`;
  const until = Date.now() + waitMs;
  let fd: number;
  for (;;) {
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); writeSync(fd, `${process.pid}\n`); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() >= until) throw new AuthConfigError(`another change holds ${lock}; ${holder(lock)}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return run(); }
  finally { closeSync(fd); rmSync(lock, { force: true }); }
}

export function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

if (import.meta.main) {
  const [action, a, b, ...extra] = process.argv.slice(2);
  const usage = () => {
    console.error("usage: bun scripts/tokens.ts add <principal> <tokens-file> [role] | rotate|revoke <principal> <tokens-file> | role <principal> <role> <tokens-file> | list <tokens-file>");
    process.exit(2);
  };
  try {
    if (action === "list") {
      if (!a || b) usage();
      for (const [name, entry] of parseTokens(readFileSync(a!, "utf8"))) console.log(`${name} ${entry.role}`);
    } else if (action === "add" || action === "rotate" || action === "revoke" || action === "role") {
      // add takes an optional role after the file; role takes the role before the file.
      const max = action === "add" ? 1 : action === "role" ? 1 : 0;
      if (!a || !b || extra.length > max || (action === "role" && extra.length !== 1)) usage();
      const file = action === "role" ? extra[0]! : b!;
      const role = action === "role" ? b : action === "add" ? extra[0] : undefined;
      if (action !== "add" && !existsSync(file)) throw new AuthConfigError(`no tokens file ${file}`);
      const result = withLock(file, () => {
        const next = change(action, a!, existsSync(file) ? readFileSync(file, "utf8") : "", newToken(), role);
        writeAtomic(file, next.text);
        return next;
      });
      if (result.token) {
        console.error("Token (shown once, give it to the client, do not store it on the host):");
        console.log(result.token);
      }
      const done = { revoke: "Revoked", rotate: "Rotated", add: "Added", role: `Set role ${role} for` }[action];
      console.error(`${done} ${a} in ${file}. Send the service SIGHUP (or restart it) for it to take effect.`);
      if (action === "rotate") console.error("The old token stops working at that reload.");
    } else usage();
  } catch (e) {
    console.error(e instanceof AuthConfigError ? `refused: ${e.message}` : `failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
