import type { SQL } from "bun";
import type { CooperativeTransactionRunner } from "./incarnations.ts";
import { CommandError } from "../../data/commands.ts";
import { supervisorIdentity, type Principal } from "../auth.ts";
import { SupervisorIncarnations, type IncarnationCredential } from "./incarnations.ts";
import type { CentralCommand } from "./commands.ts";

// Initialize commands, delivery attempts, identities and incarnations first.
// The database fence deliberately blocks ALL updates/deletes of claimed commands.
// Before integration, legacy command mutation and delivery routes must remain blocked;
// replacing this fence requires an atomic, claim-aware transition protocol and migration.
// Claims do not prove acceptance, execution, or fence effects already started externally.
export class CooperativeClaims {
  constructor(private db: SQL, private incarnations: SupervisorIncarnations, private now: () => Date = () => new Date(), private runner?: CooperativeTransactionRunner) {}

  async initialize(): Promise<void> {
    // This lock coordinates existing writers, not concurrent initialization or installation.
    await this.db.begin(async (tx) => {
      const [location] = await tx<{ schema: string | null }[]>`SELECT current_schema() AS schema`;
      if (!location?.schema) throw new Error("no current schema for cooperative claims");
      const schema = location.schema;
      const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
      const body = `BEGIN
        IF EXISTS (SELECT 1 FROM ${quotedSchema}.central_cooperative_claims WHERE command_id = OLD.id) THEN
          RAISE EXCEPTION 'claimed command cannot be mutated before cooperative integration';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END`;
      await tx`CREATE TABLE IF NOT EXISTS ${tx(schema)}.central_cooperative_claims (
        incarnation_id TEXT NOT NULL REFERENCES ${tx(schema)}.central_supervisor_incarnations_v2(id),
        request_id TEXT NOT NULL, command_id TEXT UNIQUE REFERENCES ${tx(schema)}.central_commands(id),
        created_at TEXT NOT NULL, PRIMARY KEY (incarnation_id, request_id)
      )`;
      await tx.unsafe(`CREATE OR REPLACE FUNCTION ${quotedSchema}.central_block_cooperative_claim_mutation() RETURNS trigger LANGUAGE plpgsql AS '${body.replaceAll("'", "''")}'`);
      const lock = await tx`SELECT id FROM ${tx(schema)}.central_command_event_lock WHERE id = 1 FOR UPDATE`;
      if (!lock.length) throw new Error("central command event lock row missing");
      await tx`DROP TRIGGER IF EXISTS central_block_cooperative_claim_mutation ON ${tx(schema)}.central_commands`;
      await tx`CREATE TRIGGER central_block_cooperative_claim_mutation BEFORE UPDATE OR DELETE ON ${tx(schema)}.central_commands FOR EACH ROW EXECUTE FUNCTION ${tx(schema)}.central_block_cooperative_claim_mutation()`;
    });
  }

  async claim(principal: Principal, credential: IncarnationCredential, claimRequestId: string, safeResponse?: (command: CentralCommand | null) => boolean): Promise<CentralCommand | null> {
    const validate = (command: CentralCommand | null) => {
      if (!safeResponse) return;
      try {
        if (safeResponse(command ? { ...command } : null) === true) return;
      } catch {}
      throw new Error("unsafe claim response");
    };
    if (!principal || principal.role !== "supervisor") throw new Error("access denied");
    if (typeof claimRequestId !== "string" || claimRequestId.length < 1 || claimRequestId.length > 256 || claimRequestId.trim() !== claimRequestId || !claimRequestId.isWellFormed() || /[\x00-\x1f\x7f]/.test(claimRequestId)) throw new CommandError("invalid", "invalid claim request ID");
    const identity = supervisorIdentity(principal);
    if (![identity.principalId, identity.name, identity.hostId, identity.session].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value))) throw new Error("access denied");
    credential = credential && { incarnationId: credential.incarnationId, token: credential.token };
    return (this.runner ?? ((operation) => this.db.begin(operation)))(async (tx) => {
      if (!await this.incarnations.lockForClaim(tx, identity, credential)) throw new Error("access denied");
      const lock = await tx`SELECT id FROM central_command_event_lock WHERE id = 1 FOR UPDATE`;
      if (!lock.length) throw new Error("central command event lock row missing");
      const [existing] = await tx<{ commandId: string | null }[]>`SELECT command_id AS "commandId" FROM central_cooperative_claims WHERE incarnation_id = ${credential.incarnationId} AND request_id = ${claimRequestId}`;
      if (existing) {
        if (existing.commandId === null) {
          validate(null);
          return null;
        }
        const [command] = await tx<CentralCommand[]>`SELECT id, idempotency_key AS "idempotencyKey", host_id AS "hostId", target, actor, text, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM central_commands WHERE id = ${existing.commandId}`;
        if (!command) throw new Error("claimed command missing");
        validate(command);
        return command;
      }
      const [command] = await tx<CentralCommand[]>`SELECT id, idempotency_key AS "idempotencyKey", host_id AS "hostId", target, actor, text, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM central_commands AS command
        WHERE host_id = ${identity.hostId} AND target = ${identity.session} AND status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM central_delivery_attempts WHERE command_id = command.id)
          AND NOT EXISTS (SELECT 1 FROM central_cooperative_claims WHERE command_id = command.id)
        ORDER BY created_at, id LIMIT 1 FOR UPDATE`;
      const at = this.now().toISOString();
      validate(command ? { ...command, status: "claimed", updatedAt: at } : null);
      let claimed: CentralCommand | null = null;
      if (command) {
        const [updated] = await tx<CentralCommand[]>`UPDATE central_commands SET status = 'claimed', updated_at = ${at} WHERE id = ${command.id} AND status = 'queued'
          RETURNING id, idempotency_key AS "idempotencyKey", host_id AS "hostId", target, actor, text, status, created_at AS "createdAt", updated_at AS "updatedAt"`;
        if (!updated) throw new Error("queued command could not be claimed");
        validate(updated);
        claimed = updated;
      }
      await tx`INSERT INTO central_cooperative_claims (incarnation_id, request_id, command_id, created_at) VALUES (${credential.incarnationId}, ${claimRequestId}, ${claimed?.id ?? null}, ${at})`;
      if (claimed) await tx`INSERT INTO central_command_events (command_id, status, actor, detail, at) VALUES (${claimed.id}, 'claimed', ${identity.name}, ${`cooperative claim ${credential.incarnationId}`}, ${at})`;
      return claimed;
    });
  }
}
