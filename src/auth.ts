// Bearer-token auth for REST, WebSocket and MCP. Each token names one principal; that name
// becomes the actor recorded for commands, answers and phase writes.
import { createHash, timingSafeEqual } from "node:crypto";

export type Principal = { name: string };

export class AuthConfigError extends Error {}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest();

// Tokens file: one `<principal> <sha256 hex of token>` per line, `#` comments. Only hashes are
// stored on the host, so the file leaks no usable secret.
export function parseTokens(text: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const hashes = new Set<string>();
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s+([0-9a-f]{64})$/);
    if (!m || !NAME.test(m[1]!)) throw new AuthConfigError(`tokens file line ${i + 1}: expected "<name> <sha256 hex>"`);
    if (out.has(m[1]!)) throw new AuthConfigError(`tokens file line ${i + 1}: duplicate principal ${m[1]}`);
    if (hashes.has(m[2]!)) throw new AuthConfigError(`tokens file line ${i + 1}: duplicate token hash`);
    hashes.add(m[2]!);
    out.set(m[1]!, Buffer.from(m[2]!, "hex"));
  }
  if (out.size === 0) throw new AuthConfigError("tokens file has no principals");
  return out;
}

export const COOKIE = "fc_session";

export class Auth {
  private readonly hashes: Map<string, Buffer>;
  private readonly listeners = new Set<() => void>();
  // The token hash behind each principal this instance returned, so a socket opened with a token
  // can be closed when that token goes away. Kept out of the principal value itself.
  private readonly keys = new WeakMap<Principal, string>();

  constructor(hashes: Map<string, Buffer>) {
    const seen = new Set<string>();
    this.hashes = new Map();
    for (const [name, hash] of hashes) {
      if (!Buffer.isBuffer(hash) || hash.length !== 32) throw new AuthConfigError("invalid token hash");
      const key = hash.toString("hex");
      if (seen.has(key)) throw new AuthConfigError("duplicate token hash");
      seen.add(key);
      this.hashes.set(name, Buffer.from(hash));
    }
  }

  static async fromFile(path: string): Promise<Auth> {
    return new Auth(parseTokens(await Bun.file(path).text()));
  }

  // Swap in a reread tokens file. Checked in full first, so a bad file leaves the old tokens working.
  replace(next: Auth): void {
    this.hashes.clear();
    for (const [name, hash] of next.hashes) this.hashes.set(name, hash);
    for (const listener of this.listeners) listener();
  }

  // Called after every replace, so holders of long-lived connections can drop revoked ones.
  onReplace(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Whether the token behind `principal` still belongs to it (false after a revoke or rotate).
  current(principal: Principal): boolean {
    const key = this.keys.get(principal);
    return key !== undefined && this.hashes.get(principal.name)?.toString("hex") === key;
  }

  names(): string[] {
    return [...this.hashes.keys()];
  }

  check(token: string | null | undefined): Principal | null {
    if (!token || token.length > 512) return null;
    const h = sha256(token);
    let found: string | null = null;
    // compare against every entry so timing does not reveal which principal matched
    for (const [name, want] of this.hashes) if (timingSafeEqual(h, want)) found = name;
    if (!found) return null;
    const principal = { name: found };
    this.keys.set(principal, h.toString("hex"));
    return principal;
  }

  // Authorization: Bearer for MCP and scripts, the session cookie for the browser page.
  principal(req: Request): Principal | null {
    const header = req.headers.get("authorization");
    if (header) return this.check(header.match(/^Bearer\s+(\S+)$/i)?.[1]);
    const cookie = req.headers.get("cookie") ?? "";
    const value = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    let token: string | null = null;
    try { token = value ? decodeURIComponent(value) : null; }
    catch (error) { if (error instanceof URIError) return null; throw error; }
    return this.check(token);
  }
}

export function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export function tokenLine(name: string, token: string): string {
  if (!NAME.test(name)) throw new AuthConfigError("principal name must match [A-Za-z0-9._-]{1,64}");
  return `${name} ${sha256(token).toString("hex")}`;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
