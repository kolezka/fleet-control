// Manage the host tokens file without hand edits: add, rotate, revoke, list.
// Usage: bun scripts/tokens.ts add|rotate <principal> <tokens-file>
//        bun scripts/tokens.ts revoke <principal> <tokens-file>
//        bun scripts/tokens.ts list <tokens-file>
// The new token is printed once on stdout. The file is checked, then replaced atomically with mode 0600.
// The running service reads the file at start, so restart it for a change to take effect.
import { chmodSync, closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { AuthConfigError, newToken, parseTokens, tokenLine } from "../src/auth.ts";

export type Change = { action: "add" | "rotate" | "revoke"; name: string; token?: string; text: string };

const lineName = (raw: string) => {
  const line = raw.trim();
  return !line || line.startsWith("#") ? null : line.split(/\s+/)[0]!;
};

// Pure: returns the new file text. Comments and order are kept; the result must parse.
export function change(action: Change["action"], name: string, text: string, token = newToken()): Change {
  tokenLine(name, token); // validates the name
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const at = lines.findIndex((l) => lineName(l) === name);
  if (action === "add") {
    if (at >= 0) throw new AuthConfigError(`${name} already has a token; use rotate`);
    lines.push(tokenLine(name, token));
  } else if (at < 0) {
    throw new AuthConfigError(`no principal ${name} in the tokens file`);
  } else if (action === "rotate") {
    lines[at] = tokenLine(name, token);
  } else {
    lines.splice(at, 1);
  }
  const out = lines.length ? `${lines.join("\n")}\n` : "";
  parseTokens(out); // refuses an empty file and duplicate names or hashes, as the service would
  return { action, name, ...(action === "revoke" ? {} : { token }), text: out };
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
    console.error("usage: bun scripts/tokens.ts add|rotate|revoke <principal> <tokens-file> | list <tokens-file>");
    process.exit(2);
  };
  try {
    if (action === "list") {
      if (!a || b) usage();
      for (const name of parseTokens(readFileSync(a!, "utf8")).keys()) console.log(name);
    } else if (action === "add" || action === "rotate" || action === "revoke") {
      if (!a || !b || extra.length) usage();
      const text = existsSync(b!) ? readFileSync(b!, "utf8") : "";
      if (action !== "add" && !existsSync(b!)) throw new AuthConfigError(`no tokens file ${b}`);
      const result = change(action, a!, text);
      writeAtomic(b!, result.text);
      if (result.token) {
        console.error("Token (shown once, give it to the client, do not store it on the host):");
        console.log(result.token);
      }
      console.error(`${action === "revoke" ? "Revoked" : action === "rotate" ? "Rotated" : "Added"} ${a} in ${b}. Restart the service for it to take effect.`);
      if (action === "rotate") console.error("The old token stops working at that restart.");
    } else usage();
  } catch (e) {
    console.error(e instanceof AuthConfigError ? `refused: ${e.message}` : `failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
