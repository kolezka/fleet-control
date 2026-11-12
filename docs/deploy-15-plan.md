# Deployment plan for 192.168.50.15

Status: proposal, 2026-11-12. Nothing here is done. The owner chose `.15` as the deployment host; every step below that touches `.15` still needs the owner's go-ahead.

## What exists today

- `src/central/cooperative-main.ts` is a disposable experiment. It accepts only `127.0.0.1:57507/fleet_control_test`, creates a fresh schema on every start and binds only to `127.0.0.1`. It cannot be deployed as it is.
- `src/central/main.ts` (legacy entry point) also binds only to `127.0.0.1` and takes `CENTRAL_DATABASE_URL`, `CENTRAL_CREDENTIALS_FILE`, `CENTRAL_PORT` and optional TLS files. The owner decided not to migrate legacy data (option A in [legacy-migration-proposal.md](legacy-migration-proposal.md)).
- Both entry points have optional TLS. No certificate exists for `.15`.
- `.15` runs a production fleet (`tv-*`). Its sessions must not be attached to, sent to or killed.
- Access: the Mac mini (`.4`) has no SSH key accepted by `root@192.168.50.15:27022` (`Permission denied (publickey,password)` on 2026-11-12). Its host key was recorded on first contact: ED25519 `SHA256:6zSQESslMUUOVv+athgHB99I0qvvfOtPCx4mOev+hWc`.

## Steps

1. **Access (owner).** Add the Mac mini's public key to the account the owner picks on `.15`. Then a read-only inventory: OS, Bun, Docker, PostgreSQL, free disk and memory, listening ports. No changes.
2. **Persistent cooperative entry point (code, local).** A new entry point, or a mode of the existing one, that opens an existing provisioned schema instead of creating one, takes the database URL from a private file instead of the fixed test URL, and keeps all current guards (restricted runtime role, schema guard, no ambient `PG*` variables). Provisioning stays a separate one-time admin step. Tested locally against the Docker fixture first.
3. **Listener exposure (decision).** Both entry points bind only to `127.0.0.1`. Options: keep loopback and reach it over an SSH tunnel from the MacBook (no code change, recommended first), or allow a LAN bind with TLS required (code change and a review).
4. **PostgreSQL on `.15` (owner).** A dedicated PostgreSQL 17 container bound to `127.0.0.1` with a named volume, a password-protected admin role and the restricted runtime role. Backups with `scripts/central-backup.ts` to a second machine; a backup counts only after a checked restore into a throwaway database.
5. **Certificates (owner).** Proposal: the same as `.4`. The owner's mkcert CA on the MacBook issues a certificate for `IP:192.168.50.15`; the key is copied to `.15` once, mode 0600, owned by the service user. Not needed if step 3 stays on an SSH tunnel.
6. **Service (owner).** A systemd unit running as `me` (not root), with `Restart=on-failure` and secrets in private files, not in the unit. Separate from the production fleet's tmux sessions.
7. **Verification.** Operator submit, a synthetic supervisor claim and reports, operator inspection and a stale-incarnation rejection against `.15`, then one real-agent run as in `scripts/real-agent-smoke.ts` on a scratch session, never on `tv-*`.

Rollback at every step: stop and disable the unit, remove the container and its volume only after a checked backup. Nothing in this plan changes the production fleet.
