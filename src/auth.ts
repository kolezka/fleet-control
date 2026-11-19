// Bearer-token auth for REST, WebSocket and MCP. Each token names one principal; that name
// becomes the actor recorded for commands, answers and phase writes.
import { createHash, timingSafeEqual } from "node:crypto";
import { isRole, LEGACY_ROLE, ROLES, type Role } from "./domain/roles.ts";

export type Principal = { name: string; role: Role };
export type TokenEntry = { hash: Buffer; role: Role };

export class AuthConfigError extends Error {}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest();

// Tokens file: one `<principal> <sha256 hex of token> [role]` per line, `#` comments. Only hashes are
// stored on the host, so the file leaks no usable secret. A line without a role is an agent.
export function parseTokens(text: string): Map<string, TokenEntry> {
  const out = new Map<string, TokenEntry>();
  const hashes = new Set<string>();
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s+([0-9a-f]{64})(?:\s+(\S+))?$/);
    if (!m || !NAME.test(m[1]!)) throw new AuthConfigError(`tokens file line ${i + 1}: expected "<name> <sha256 hex> [role]"`);
    if (m[3] !== undefined && !isRole(m[3])) throw new AuthConfigError(`tokens file line ${i + 1}: role must be one of ${ROLES.join(", ")}`);
    if (out.has(m[1]!)) throw new AuthConfigError(`tokens file line ${i + 1}: duplicate principal ${m[1]}`);
    if (hashes.has(m[2]!)) throw new AuthConfigError(`tokens file line ${i + 1}: duplicate token hash`);
    hashes.add(m[2]!);
    out.set(m[1]!, { hash: Buffer.from(m[2]!, "hex"), role: (m[3] as Role | undefined) ?? LEGACY_ROLE });
  }
  if (out.size === 0) throw new AuthConfigError("tokens file has no principals");
  return out;
}

export const COOKIE = "fc_session";

export class Auth {
  private readonly hashes: Map<string, Buffer>;
  private readonly roles = new Map<string, Role>();
  private readonly listeners = new Set<() => void>();
  // The token hash behind each principal this instance returned, so a socket opened with a token
  // can be closed when that token goes away. Kept out of the principal value itself.
  private readonly keys = new WeakMap<Principal, string>();

  // A bare Buffer is a hash without a role, as an old tokens line, so it counts as an agent.
  constructor(entries: Map<string, Buffer | TokenEntry>) {
    const seen = new Set<string>();
    this.hashes = new Map();
    for (const [name, entry] of entries) {
      const { hash, role } = Buffer.isBuffer(entry) || !entry || typeof entry !== "object" ? { hash: entry as Buffer, role: LEGACY_ROLE } : entry;
      if (!isRole(role)) throw new AuthConfigError("invalid role");
      if (!Buffer.isBuffer(hash) || hash.length !== 32) throw new AuthConfigError("invalid token hash");
      const key = hash.toString("hex");
      if (seen.has(key)) throw new AuthConfigError("duplicate token hash");
      seen.add(key);
      this.hashes.set(name, Buffer.from(hash));
      this.roles.set(name, role);
    }
  }

  static async fromFile(path: string): Promise<Auth> {
    return new Auth(parseTokens(await Bun.file(path).text()));
  }

  // Swap in a reread tokens file. Checked in full first, so a bad file leaves the old tokens working.
  replace(next: Auth): void {
    this.hashes.clear();
    this.roles.clear();
    for (const [name, hash] of next.hashes) this.hashes.set(name, hash);
    for (const [name, role] of next.roles) this.roles.set(name, role);
    for (const listener of this.listeners) listener();
  }

  // Called after every replace, so holders of long-lived connections can drop revoked ones.
  onReplace(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Whether the token behind `principal` still belongs to it with the same role (false after a
  // revoke, a rotate or a role change).
  current(principal: Principal): boolean {
    const key = this.keys.get(principal);
    return key !== undefined && this.hashes.get(principal.name)?.toString("hex") === key && this.roles.get(principal.name) === principal.role;
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
    const principal: Principal = { name: found, role: this.roles.get(found)! };
    this.keys.set(principal, h.toString("hex"));
    return principal;
  }

  // Whether any word of `text` is a current token. Delivered text stays in the pane's scrollback,
  // where every terminal viewer can read it. Candidates are whitespace-separated words, runs of
  // token characters inside them, and runs of base64url characters (what newToken makes), so
  // quotes, "Bearer ", "token=" or "?t=" around a token do not hide it. Every window of
  // TOKEN_LENGTH characters is checked too, so a newToken token glued to other text is caught.
  appearsIn(text: string): boolean {
    const words = new Set<string>();
    for (const word of text.split(/\s+/)) {
      if (word) words.add(word);
      for (const run of word.match(/[A-Za-z0-9._~+\/=-]+/g) ?? []) words.add(run);
      for (const run of word.match(/[A-Za-z0-9_-]+/g) ?? []) words.add(run);
    }
    for (let i = 0; i + TOKEN_LENGTH <= text.length; i++) words.add(text.slice(i, i + TOKEN_LENGTH));
    for (const word of words) if (this.check(word)) return true;
    return false;
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

// Length of every newToken result: 32 random bytes in base64url without padding.
export const TOKEN_LENGTH = 43;

export function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

// Without a role the line is in the old two-column form, which every release reads as an agent.
export function tokenLine(name: string, token: string, role?: Role): string {
  if (!NAME.test(name)) throw new AuthConfigError("principal name must match [A-Za-z0-9._-]{1,64}");
  if (role !== undefined && !isRole(role)) throw new AuthConfigError(`role must be one of ${ROLES.join(", ")}`);
  return `${name} ${sha256(token).toString("hex")}${role ? ` ${role}` : ""}`;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
