import { createHash, timingSafeEqual } from "node:crypto";
import { type SupervisorIdentity, type SupervisorIdentityLookup, supervisorIdentity, type Principal, type Credential, validId } from "./domain/identity.ts";

export class AuthConfigError extends Error {}

export class CentralAuth {
  private readonly credentials: { hash: Buffer; principal: Principal }[];

  constructor(credentials: Credential[]) {
    if (!Array.isArray(credentials) || credentials.length === 0) throw new AuthConfigError("credentials are required");
    const hashes = new Set<string>();
    const names = new Set<string>();
    const supervisorIds = new Set<string>();
    this.credentials = credentials.map((credential) => {
      const p = credential?.principal;
      if (!credential || typeof credential.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(credential.tokenHash)) {
        throw new AuthConfigError("token hash must be a lowercase SHA-256 hex digest");
      }
      if (!p || !validId(p.name) || !["operator", "host", "supervisor"].includes(p.role)) {
        throw new AuthConfigError("invalid principal");
      }
      if ((p.role === "host" || p.role === "supervisor") && !validId(p.hostId)) throw new AuthConfigError("host scope is required");
      if (p.role === "supervisor" && !validId(p.session)) throw new AuthConfigError("session scope is required");
      if (p.role === "supervisor" && !validId(p.principalId)) throw new AuthConfigError("supervisor principal ID is required");
      if (hashes.has(credential.tokenHash) || names.has(p.name) || (p.role === "supervisor" && supervisorIds.has(p.principalId))) throw new AuthConfigError("duplicate token hash or principal identity");
      if (p.role === "supervisor") supervisorIds.add(p.principalId);
      hashes.add(credential.tokenHash);
      names.add(p.name);
      const principal: Principal = p.role === "operator" ? { name: p.name, role: p.role }
        : p.role === "host" ? { name: p.name, role: p.role, hostId: p.hostId }
        : { name: p.name, role: p.role, principalId: p.principalId, hostId: p.hostId, session: p.session };
      return { hash: Buffer.from(credential.tokenHash, "hex"), principal };
    });
  }

  async validateSupervisors(identities: SupervisorIdentityLookup): Promise<void> {
    for (const { principal } of this.credentials) {
      if (principal.role === "supervisor" && await identities.matches(supervisorIdentity(principal)) !== true) {
        throw new AuthConfigError("configured supervisor identity is not active");
      }
    }
  }

  authenticate(request: Request): Principal | null {
    const token = request.headers.get("authorization")?.match(/^Bearer[ \t]+([^\s]+)$/i)?.[1];
    if (!token || token.length > 512) return null;
    const digest = createHash("sha256").update(token).digest();
    let principal: Principal | null = null;
    for (const credential of this.credentials) {
      if (timingSafeEqual(digest, credential.hash)) principal = credential.principal;
    }
    return principal ? { ...principal } : null;
  }
}
