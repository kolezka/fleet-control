// The host's tokens file as the page sees it. Changes go through the same lock and atomic write as
// scripts/tokens.ts, and are loaded into the running service at once, so a revoked token stops at once.
import { readFileSync } from "node:fs";
import { change, withLock, writeAtomic } from "../scripts/tokens.ts";
import { Auth, AuthConfigError, parseTokens } from "./auth.ts";
import { AdminError } from "./domain/fleet-admin.ts";
import type { TokenRow } from "./domain/token-admin.ts";
import type { TokenChange, TokenFile } from "./application/token-admin.ts";

const rowsOf = (text: string): TokenRow[] => [...parseTokens(text)].map(([name, e]) => ({ name, role: e.role }));

export class HostTokenFile implements TokenFile {
  constructor(readonly file: string, readonly auth: Auth) {}

  async rows(): Promise<TokenRow[]> {
    return rowsOf(readFileSync(this.file, "utf8"));
  }

  async change(name: string, decide: (rows: TokenRow[]) => TokenChange): Promise<string | null> {
    let token: string | null = null;
    try {
      withLock(this.file, () => {
        const text = readFileSync(this.file, "utf8");
        const what = decide(rowsOf(text));
        let out: string;
        if (what.kind === "rotate") {
          const c = change("rotate", name, text);
          token = c.token!;
          out = c.text;
        } else if (what.kind === "revoke") {
          out = change("revoke", name, text).text;
        } else {
          // Same line with the new hash; the role stays.
          const lines = text.replace(/\n$/, "").split("\n");
          const at = lines.findIndex((l) => l.trim().split(/\s+/)[0] === name && !l.trim().startsWith("#"));
          if (at < 0) throw new AdminError("not_found", `no principal ${name} in the tokens file`);
          const [n, , role] = lines[at]!.trim().split(/\s+/);
          lines[at] = `${n} ${what.hash}${role ? ` ${role}` : ""}`;
          out = `${lines.join("\n")}\n`;
          parseTokens(out);
        }
        writeAtomic(this.file, out);
        // Loaded while the lock is still held, from the text just written: a later change cannot be
        // overtaken by a slower reload of this one.
        this.auth.replace(new Auth(parseTokens(out)));
      });
    } catch (e) {
      // Lock held, a duplicate hash, an empty file: the file is unchanged, the reason goes to the operator.
      if (e instanceof AuthConfigError) throw new AdminError("invalid", e.message);
      throw e;
    }
    return token;
  }
}
