import { createHash, timingSafeEqual } from "node:crypto";
import type { SupervisorIdentity } from "./identity-registry.ts";

export type SupervisorIdentityLookup = { matches(identity: SupervisorIdentity): Promise<boolean> };

export function supervisorIdentity(principal: Extract<Principal, { role: "supervisor" }>): SupervisorIdentity {
  return { principalId: principal.principalId, name: principal.name, hostId: principal.hostId, session: principal.session };
}

export type Principal =
  | { name: string; role: "operator" }
  | { name: string; role: "host"; hostId: string }
  | { name: string; role: "supervisor"; principalId: string; hostId: string; session: string };

export type Credential = { tokenHash: string; principal: Principal };
export type Scope = { hostId?: string; session?: string };
export class AuthConfigError extends Error {}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);

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

export function authorize(principal: Principal | null, role: Principal["role"], scope: Scope = {}): boolean {
  if (!principal || principal.role !== role) return false;
  if (principal.role === "operator") return true;
  if (!validId(scope.hostId) || principal.hostId !== scope.hostId) return false;
  return principal.role !== "supervisor" || (validId(scope.session) && principal.session === scope.session);
}
