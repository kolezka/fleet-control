import type { SQL } from "bun";

export type SupervisorIdentity = { principalId: string; name: string; hostId: string; session: string };

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);

function validIdentity(identity: SupervisorIdentity): boolean {
  return !!identity && validId(identity.principalId) && validId(identity.name) && validId(identity.hostId) && validId(identity.session);
}

// Enrollment and retirement are operator actions, never derived from a request principal.
// Existing principals are not migrated automatically; the caller must enroll trusted bindings.
export class SupervisorIdentityRegistry {
  constructor(private db: SQL) {}

  async initialize(): Promise<void> {
    await this.db`CREATE TABLE IF NOT EXISTS central_supervisor_identities_v2 (
      principal_id TEXT PRIMARY KEY, name TEXT NOT NULL, host_id TEXT NOT NULL, session TEXT NOT NULL,
      retired BOOLEAN NOT NULL DEFAULT FALSE
    )`;
  }

  async enroll(identity: SupervisorIdentity): Promise<void> {
    if (!validIdentity(identity)) throw new Error("invalid supervisor identity");
    await this.db.begin(async (tx) => {
      await tx`INSERT INTO central_supervisor_identities_v2 (principal_id, name, host_id, session)
        VALUES (${identity.principalId}, ${identity.name}, ${identity.hostId}, ${identity.session}) ON CONFLICT (principal_id) DO NOTHING`;
      const [stored] = await tx<{ name: string; hostId: string; session: string; retired: boolean }[]>`
        SELECT name, host_id AS "hostId", session, retired FROM central_supervisor_identities_v2 WHERE principal_id = ${identity.principalId} FOR UPDATE`;
      if (!stored || stored.retired || stored.name !== identity.name || stored.hostId !== identity.hostId || stored.session !== identity.session) {
        throw new Error("supervisor identity conflicts with existing or retired binding");
      }
    });
  }

  async matches(identity: SupervisorIdentity): Promise<boolean> {
    if (!validIdentity(identity)) return false;
    const rows = await this.db`SELECT principal_id FROM central_supervisor_identities_v2
      WHERE principal_id = ${identity.principalId} AND name = ${identity.name} AND host_id = ${identity.hostId}
        AND session = ${identity.session} AND retired = FALSE`;
    return rows.length === 1;
  }

  async retire(identity: SupervisorIdentity): Promise<void> {
    if (!validIdentity(identity)) throw new Error("invalid supervisor identity");
    const rows = await this.db`UPDATE central_supervisor_identities_v2 SET retired = TRUE
      WHERE principal_id = ${identity.principalId} AND name = ${identity.name} AND host_id = ${identity.hostId} AND session = ${identity.session}
      RETURNING principal_id`;
    if (rows.length !== 1) throw new Error("supervisor identity does not match an existing binding");
  }
}
