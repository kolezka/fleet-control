// Prints a new access token once and the line to append to the host's tokens file.
// Usage: bun scripts/new-token.ts <principal>   e.g. macbook-session, web-mariusz, supervisor
import { newToken, tokenLine } from "../src/auth.ts";

const name = process.argv[2];
if (!name) {
  console.error("usage: bun scripts/new-token.ts <principal>");
  process.exit(2);
}
const token = newToken();
console.error("Token (shown once, give it to the client, do not store it on the host):");
console.log(token);
console.error("\nAppend this line to the tokens file on the host:");
console.error(tokenLine(name, token));
