// Who may act on central: principals, supervisor identities and scope checks.

export type SupervisorIdentity = { principalId: string; name: string; hostId: string; session: string };

export const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);

export function validIdentity(identity: SupervisorIdentity): boolean {
  return !!identity && validId(identity.principalId) && validId(identity.name) && validId(identity.hostId) && validId(identity.session);
}

export type IncarnationCredential = { incarnationId: string; token: string };

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

export function authorize(principal: Principal | null, role: Principal["role"], scope: Scope = {}): boolean {
  if (!principal || principal.role !== role) return false;
  if (principal.role === "operator") return true;
  if (!validId(scope.hostId) || principal.hostId !== scope.hostId) return false;
  return principal.role !== "supervisor" || (validId(scope.session) && principal.session === scope.session);
}
