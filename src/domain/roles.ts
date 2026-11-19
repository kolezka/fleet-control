// What each token role may do on a host service. With auth every caller has exactly one role.
// operator: the human's console (gateway, browser, DSH panel); only it answers requests.
// agent: orchestrators and workers; queue commands and write their own run records.
// viewer: reads sessions, terminals, commands and requests, changes nothing.
export const ROLES = ["operator", "agent", "viewer"] as const;
export type Role = (typeof ROLES)[number];

// A tokens file line written before roles existed has no role and counts as an agent,
// so an old file keeps working and gains no authority it did not have before.
export const LEGACY_ROLE: Role = "agent";

export const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

export type Caller = { name: string; role: Role };

// write: queue, deliver, answer or report commands and write runs, phases and requests.
// answer: resolve a supervisor request, which is the human decision itself.
// operate: start and stop agents on the host, which runs code and spends money.
export type Permission = "write" | "answer" | "operate";

const allowed: Record<Role, Permission[]> = {
  operator: ["write", "answer", "operate"],
  agent: ["write"],
  viewer: [],
};

export const may = (role: Role, permission: Permission): boolean => allowed[role].includes(permission);

export class RoleError extends Error {
  readonly kind = "forbidden" as const;
  constructor(readonly role: Role, permission: Permission) {
    super(`role ${role} may not ${permission === "answer" ? "answer requests" : permission === "operate" ? "start or stop agents" : "change anything"}`);
  }
}

// Throws unless the caller may do this. No caller means no auth (loopback only), where names are self-declared.
export function requirePermission(caller: Caller | undefined, permission: Permission): void {
  if (caller && !may(caller.role, permission)) throw new RoleError(caller.role, permission);
}
