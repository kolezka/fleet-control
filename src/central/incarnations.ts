import type { SQL, TransactionSQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { validIdentity, type SupervisorIdentity } from "./identity-registry.ts";

export type CooperativeTransactionRunner = <T>(operation: (tx: TransactionSQL) => Promise<T>) => Promise<T>;

export type IncarnationCredential = { incarnationId: string; token: string };

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

// Initialize SupervisorIdentityRegistry first. Activation is a trusted operator action,
// never an operation available merely because a requester supplies an identity.
export class SupervisorIncarnations {
  constructor(private db: SQL, private runner?: CooperativeTransactionRunner) {}

  async initialize(): Promise<void> {
    await this.db`CREATE TABLE IF NOT EXISTS central_supervisor_slots_v2 (
      host_id TEXT NOT NULL, session TEXT NOT NULL, PRIMARY KEY (host_id, session)
    )`;
    await this.db`CREATE TABLE IF NOT EXISTS central_supervisor_incarnations_v2 (
      ordinal BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      principal_id TEXT NOT NULL REFERENCES central_supervisor_identities_v2(principal_id),
      token_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    )`;
    await this.db`CREATE UNIQUE INDEX IF NOT EXISTS central_supervisor_one_active_incarnation_v2
      ON central_supervisor_incarnations_v2 (principal_id) WHERE active`;
  }

  async activate(identity: SupervisorIdentity): Promise<IncarnationCredential> {
    identity = identity && { principalId: identity.principalId, name: identity.name, hostId: identity.hostId, session: identity.session };
    if (!validIdentity(identity)) throw new Error("invalid supervisor identity");
    const token = randomBytes(32).toString("base64url");
    return (this.runner ?? ((operation) => this.db.begin(operation)))(async (tx) => {
      await tx`INSERT INTO central_supervisor_slots_v2 (host_id, session)
        VALUES (${identity.hostId}, ${identity.session}) ON CONFLICT DO NOTHING`;
      await tx`SELECT host_id FROM central_supervisor_slots_v2
        WHERE host_id = ${identity.hostId} AND session = ${identity.session} FOR UPDATE`;
      const [binding] = await tx`SELECT principal_id FROM central_supervisor_identities_v2
        WHERE principal_id = ${identity.principalId} AND name = ${identity.name}
          AND host_id = ${identity.hostId} AND session = ${identity.session} AND NOT retired FOR UPDATE`;
      if (!binding) throw new Error("supervisor identity is missing, retired, or does not match");
      await tx`UPDATE central_supervisor_incarnations_v2 SET active = FALSE
        WHERE active AND principal_id IN (SELECT principal_id FROM central_supervisor_identities_v2
          WHERE host_id = ${identity.hostId} AND session = ${identity.session})`;
      const id = crypto.randomUUID();
      await tx`INSERT INTO central_supervisor_incarnations_v2 (id, principal_id, token_hash)
        VALUES (${id}, ${identity.principalId}, ${digest(token)})`;
      return { incarnationId: id, token };
    });
  }

  // Must run inside the caller's transaction, before its claim writes. Always lock
  // slot first, then identity and incarnation, and retain locks until commit or rollback.
  // Replacement serializes on the slot, retirement on the identity: a claim that
  // locks first can commit before revocation; one that locks after revocation fails.
  // This fences later database claims, not work already claimed or external effects.
  async lockForClaim(tx: TransactionSQL, identity: SupervisorIdentity, credential: IncarnationCredential): Promise<boolean> {
    identity = identity && { principalId: identity.principalId, name: identity.name, hostId: identity.hostId, session: identity.session };
    credential = credential && { incarnationId: credential.incarnationId, token: credential.token };
    if (!validIdentity(identity) || !credential || typeof credential.incarnationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(credential.incarnationId)
      || typeof credential.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(credential.token)) return false;
    const [slot] = await tx`SELECT host_id FROM central_supervisor_slots_v2
      WHERE host_id = ${identity.hostId} AND session = ${identity.session} FOR UPDATE`;
    if (!slot) return false;
    const [binding] = await tx`SELECT principal_id FROM central_supervisor_identities_v2
      WHERE principal_id = ${identity.principalId} AND name = ${identity.name}
        AND host_id = ${identity.hostId} AND session = ${identity.session} AND NOT retired FOR UPDATE`;
    if (!binding) return false;
    const [incarnation] = await tx`SELECT ordinal FROM central_supervisor_incarnations_v2
      WHERE id = ${credential.incarnationId} AND principal_id = ${identity.principalId}
        AND active AND token_hash = ${digest(credential.token)} FOR UPDATE`;
    return !!incarnation;
  }
}
