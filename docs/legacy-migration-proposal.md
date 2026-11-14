# Migration from the legacy central entry point

Status: decided 2026-11-12. The owner confirmed there is no legacy central data worth keeping, so option A applies: no migration. Nothing in this document will be implemented unless that changes.

## Current state

- `src/central/main.ts` (legacy) creates its tables with `CREATE TABLE IF NOT EXISTS` in whatever schema the connection's `search_path` resolves to, usually `public`. It initializes commands, requests and supervisor identities only. It has no incarnations, claims, lifecycle events, settlements, schema marker, triggers or restricted runtime role.
- `src/central/data/cooperative-provision.ts` creates a new schema (default `fleet_cooperative_v1`) and fails if it already exists. It does not upgrade, repair or adopt legacy tables.
- `src/central/data/cooperative-provision.test.ts` checks that each table the provisioner creates has the same columns, indexes and constraints as the legacy `initialize()` methods create. So row shapes match for the shared tables.
- Legacy command statuses include `delivering`, `delivered` and `delivery_unknown`. The cooperative path adds `claimed`. A command in `delivering` or `delivery_unknown` has an unknown outcome.
- Neither central entry point is deployed. As far as this repository records, no legacy central database with real data exists. That should be confirmed before choosing.

Fixed owner decisions that any option must keep: no automatic requeue, no successor command, unknown outcomes are never retried automatically.

## Options

### A. No migration (smallest)

The cooperative schema starts empty. Legacy tables stay where they are, untouched, and can be dumped with `scripts/central-backup.ts` for reference. Supervisor identities are enrolled again from the credentials file, as `src/central/cooperative-main.ts` already does.

Cost: legacy history is not visible in the new schema. Fits if no real legacy data exists.

### B. One-way copy of history, read-only

A trusted administration script copies identities, commands, command events, runs, requests and request events into a freshly provisioned schema in one transaction, then compares row counts and checksums. Rules:

- Copy only. Never update or delete legacy rows.
- Commands in `queued` are not copied as `queued`: copying them would make them claimable, which is a requeue. They need an owner-chosen status, or they stay out.
- Commands in `delivering` or `delivery_unknown` are copied as they are and stay unknown.
- No incarnations, claims or settlements are invented.
- Legacy writers must be stopped first. The script checks that, it does not assume it.

Cost: a new script, its tests and a rehearsal against a copy. The `queued` rule is a policy choice for the owner.

### C. Adopt the legacy tables in place

Move or alter the existing tables into the cooperative layout and add the marker, triggers and grants. Rejected for now: it changes the only copy of the data, cannot be rehearsed without a full restore, and the provisioner is built to refuse existing schemas.

## Recommendation

A, if the owner confirms there is no legacy central data worth keeping. Otherwise B, with the `queued` rule decided first. Either way, take and check a dump before switching.

## Questions for the owner

1. Does any legacy central database with real data exist?
2. If yes, should copied `queued` commands be left out, or copied with a status that cannot be claimed?
