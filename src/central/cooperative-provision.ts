import type { SQL } from "bun";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

// PostgreSQL SCRAM-SHA-256 verifier, so the cleartext password never reaches the server or its logs.
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const stored = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest();
  const server = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored.toString("base64")}:${server.toString("base64")}`;
}

// Trusted administration only: the caller supplies a disposable local database,
// controls its roles and stops all writers that do not participate in this lock.
// The marker records installation, not the integrity of the installed objects.
export const SERVICE_RUNTIME_ROLE = "fleet_cooperative_runtime";

// Without testSchema this installs the persistent schema fleet_cooperative_v1. A
// runtimePassword then creates SERVICE_RUNTIME_ROLE in the same transaction, so a
// failed install leaves neither role nor schema. Both creates fail if they exist.
// beforeCommit runs last inside the transaction (the service writes its URL file there).
export async function provisionCooperative(db: SQL, options: { testSchema?: string; runtimeRole?: string; runtimePassword?: string; beforeCommit?: () => void | Promise<void> } = {}): Promise<void> {
  const schema = options.testSchema ?? "fleet_cooperative_v1";
  if (options.testSchema !== undefined && !/^cooperative_test_[a-f0-9]{32}$/.test(schema)) throw new Error("invalid disposable test schema");
  if ((options.beforeCommit && !options.testSchema && !options.runtimePassword) || (options.runtimeRole && !options.testSchema)) throw new Error("test options require a disposable test schema");
  if (options.runtimeRole && !/^cooperative_runtime_[a-f0-9]{32}$/.test(options.runtimeRole)) throw new Error("invalid disposable runtime role");
  if (options.runtimePassword !== undefined && (options.testSchema || !/^[A-Za-z0-9_-]{32,256}$/.test(options.runtimePassword))) throw new Error("invalid service runtime password");
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`fleet-cooperative-provision:${schema}`}, 0))`;
    if (options.runtimePassword) {
      // The verifier holds only base64, digits, "$" and ":", so it needs no quoting.
      await tx.unsafe(`CREATE ROLE "${SERVICE_RUNTIME_ROLE}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
      await tx.unsafe(`ALTER ROLE "${SERVICE_RUNTIME_ROLE}" PASSWORD '${scramVerifier(options.runtimePassword)}'`);
    }
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`CREATE TABLE ${tx(schema)}.central_commands (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, host_id TEXT NOT NULL, target TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
    await tx`CREATE TABLE ${tx(schema)}.central_command_events (seq BIGSERIAL PRIMARY KEY, command_id TEXT NOT NULL REFERENCES ${tx(schema)}.central_commands(id), status TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL)`;
    await tx`CREATE TABLE ${tx(schema)}.central_command_event_lock (id INTEGER PRIMARY KEY CHECK (id = 1))`;
    await tx`INSERT INTO ${tx(schema)}.central_command_event_lock (id) VALUES (1)`;
    await tx`CREATE TABLE ${tx(schema)}.central_delivery_attempts (ordinal BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, command_id TEXT NOT NULL REFERENCES ${tx(schema)}.central_commands(id), host_id TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, recovery_unknown BOOLEAN NOT NULL DEFAULT FALSE)`;
    await tx`CREATE TABLE ${tx(schema)}.central_supervisor_identities_v2 (principal_id TEXT PRIMARY KEY, name TEXT NOT NULL, host_id TEXT NOT NULL, session TEXT NOT NULL, retired BOOLEAN NOT NULL DEFAULT FALSE)`;
    await tx`CREATE TABLE ${tx(schema)}.central_supervisor_slots_v2 (host_id TEXT NOT NULL, session TEXT NOT NULL, PRIMARY KEY (host_id, session))`;
    await tx`CREATE TABLE ${tx(schema)}.central_supervisor_incarnations_v2 (ordinal BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL REFERENCES ${tx(schema)}.central_supervisor_identities_v2(principal_id), token_hash TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE)`;
    await tx`CREATE UNIQUE INDEX central_supervisor_one_active_incarnation_v2 ON ${tx(schema)}.central_supervisor_incarnations_v2 (principal_id) WHERE active`;
    await tx`CREATE TABLE ${tx(schema)}.central_cooperative_claims (incarnation_id TEXT NOT NULL REFERENCES ${tx(schema)}.central_supervisor_incarnations_v2(id), request_id TEXT NOT NULL, command_id TEXT UNIQUE REFERENCES ${tx(schema)}.central_commands(id), created_at TEXT NOT NULL, PRIMARY KEY (incarnation_id, request_id))`;
    await tx`CREATE TABLE ${tx(schema)}.central_cooperative_lifecycle_events (seq BIGSERIAL PRIMARY KEY, command_id TEXT NOT NULL REFERENCES ${tx(schema)}.central_cooperative_claims(command_id), incarnation_id TEXT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (incarnation_id, request_id))`;
    await tx`CREATE TABLE ${tx(schema)}.central_cooperative_settlements (command_id TEXT PRIMARY KEY REFERENCES ${tx(schema)}.central_cooperative_claims(command_id), request_id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, disposition TEXT NOT NULL CHECK (disposition IN ('completed', 'failed', 'not-executed', 'unknown')), evidence TEXT NOT NULL, expected_sequence TEXT, at TEXT NOT NULL)`;
    await tx`CREATE TABLE ${tx(schema)}.central_cooperative_reconciliations (request_id TEXT PRIMARY KEY, command_id TEXT NOT NULL REFERENCES ${tx(schema)}.central_cooperative_claims(command_id), actor TEXT NOT NULL, disposition TEXT NOT NULL, evidence TEXT NOT NULL, expected_sequence TEXT, sequence NUMERIC(1000, 0) NOT NULL CHECK (sequence > 0), supersedes_sequence NUMERIC(1000, 0), at TEXT NOT NULL, UNIQUE (command_id, sequence))`;
    await tx`CREATE TABLE ${tx(schema)}.central_runs (id TEXT PRIMARY KEY, orchestrator TEXT NOT NULL, phase TEXT NOT NULL, revision INTEGER NOT NULL, phase_status TEXT NOT NULL, updated_at TEXT NOT NULL)`;
    await tx`CREATE TABLE ${tx(schema)}.central_requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ${tx(schema)}.central_runs(id), phase TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, question TEXT NOT NULL, proposed_action TEXT NOT NULL, scope TEXT NOT NULL, evidence TEXT NOT NULL, allowed_responses TEXT NOT NULL, blocking BOOLEAN NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, response TEXT, resolved_by TEXT, resolution_note TEXT, resolved_at TEXT, created_at TEXT NOT NULL)`;
    await tx`CREATE TABLE ${tx(schema)}.central_request_events (seq BIGSERIAL PRIMARY KEY, request_id TEXT, run_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL)`;
    await tx`CREATE TABLE ${tx(schema)}.central_request_event_lock (id INTEGER PRIMARY KEY CHECK (id = 1))`;
    await tx`INSERT INTO ${tx(schema)}.central_request_event_lock (id) VALUES (1)`;
    // Identifiers are restricted above; never resolve objects via the caller's search_path.
    const quoted = `"${schema}"`;
    await tx.unsafe(`CREATE FUNCTION ${quoted}.central_block_cooperative_claim_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM ${quoted}.central_cooperative_claims WHERE command_id = OLD.id) THEN RAISE EXCEPTION 'claimed command cannot be mutated before cooperative integration'; END IF; RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END $$`);
    await tx.unsafe(`CREATE FUNCTION ${quoted}.central_block_reconciliation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reconciliation is immutable'; END $$`);
    await tx.unsafe(`CREATE FUNCTION ${quoted}.central_block_settlement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'settlement is immutable'; END $$`);
    await tx`SELECT id FROM ${tx(schema)}.central_command_event_lock WHERE id = 1 FOR UPDATE`;
    await tx`CREATE TRIGGER central_block_cooperative_claim_mutation BEFORE UPDATE OR DELETE ON ${tx(schema)}.central_commands FOR EACH ROW EXECUTE FUNCTION ${tx(schema)}.central_block_cooperative_claim_mutation()`;
    await tx`CREATE TRIGGER central_block_reconciliation_mutation BEFORE UPDATE OR DELETE ON ${tx(schema)}.central_cooperative_reconciliations FOR EACH ROW EXECUTE FUNCTION ${tx(schema)}.central_block_reconciliation_mutation()`;
    await tx`CREATE TRIGGER central_block_settlement_mutation BEFORE UPDATE OR DELETE ON ${tx(schema)}.central_cooperative_settlements FOR EACH ROW EXECUTE FUNCTION ${tx(schema)}.central_block_settlement_mutation()`;
    await tx`CREATE TABLE ${tx(schema)}.central_cooperative_schema_marker (version TEXT PRIMARY KEY CHECK (version = 'fleet_cooperative_v1'))`;
    await tx`INSERT INTO ${tx(schema)}.central_cooperative_schema_marker (version) VALUES ('fleet_cooperative_v1')`;
    const role = options.runtimeRole ?? (options.runtimePassword ? SERVICE_RUNTIME_ROLE : undefined);
    if (role) {
      await tx`GRANT USAGE ON SCHEMA ${tx(schema)} TO ${tx(role)}`;
      await tx`GRANT SELECT ON ${tx(schema)}.central_cooperative_schema_marker, ${tx(schema)}.central_delivery_attempts, ${tx(schema)}.central_cooperative_reconciliations TO ${tx(role)}`;
      await tx`GRANT SELECT, INSERT ON ${tx(schema)}.central_commands, ${tx(schema)}.central_supervisor_identities_v2, ${tx(schema)}.central_supervisor_slots_v2, ${tx(schema)}.central_supervisor_incarnations_v2 TO ${tx(role)}`;
      await tx`GRANT SELECT ON ${tx(schema)}.central_command_event_lock TO ${tx(role)}`;
      await tx`GRANT SELECT, INSERT ON ${tx(schema)}.central_cooperative_settlements TO ${tx(role)}`;
      await tx`GRANT UPDATE (status, updated_at) ON ${tx(schema)}.central_commands TO ${tx(role)}`;
      await tx`GRANT UPDATE (principal_id) ON ${tx(schema)}.central_supervisor_identities_v2 TO ${tx(role)}`;
      await tx`GRANT UPDATE (host_id) ON ${tx(schema)}.central_supervisor_slots_v2 TO ${tx(role)}`;
      await tx`GRANT UPDATE (active) ON ${tx(schema)}.central_supervisor_incarnations_v2 TO ${tx(role)}`;
      await tx`GRANT UPDATE (id) ON ${tx(schema)}.central_command_event_lock TO ${tx(role)}`;
      await tx`GRANT SELECT, INSERT ON ${tx(schema)}.central_cooperative_claims, ${tx(schema)}.central_cooperative_lifecycle_events, ${tx(schema)}.central_command_events TO ${tx(role)}`;
      await tx`GRANT USAGE ON SEQUENCE ${tx(schema)}.central_command_events_seq_seq, ${tx(schema)}.central_supervisor_incarnations_v2_ordinal_seq, ${tx(schema)}.central_cooperative_lifecycle_events_seq_seq TO ${tx(role)}`;
    }
    if (options.beforeCommit) await options.beforeCommit();
  });
}
