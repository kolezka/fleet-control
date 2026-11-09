// Prints a new access token once. With a tokens file, also appends the hash line to it.
// Usage: bun scripts/new-token.ts <principal> [tokens-file]   e.g. web-mariusz ./tokens
import { appendFile, chmod } from "node:fs/promises";
import { newToken, tokenLine } from "../src/auth.ts";

const [name, file] = process.argv.slice(2);
if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
  console.error("usage: bun scripts/new-token.ts <principal> [tokens-file]");
  process.exit(2);
}
const token = newToken();
console.error("Token (shown once, give it to the client, do not store it on the host):");
console.log(token);
if (file) {
  await appendFile(file, `${tokenLine(name, token)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  console.error(`\nAdded ${name} to ${file}.`);
} else {
  console.error("\nAppend this line to the tokens file on the host:");
  console.error(tokenLine(name, token));
}
