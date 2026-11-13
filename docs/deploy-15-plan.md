# Deployment plan for 192.168.50.15

Status: in progress. On 2026-11-13 the owner approved the persistent cooperative entry point and PostgreSQL on `.15`, and asked for docker compose. Steps 2 and 4 are now [deploy/cooperative](../deploy/cooperative/README.md).

## What exists today

- `src/central/cooperative-main.ts` is a disposable experiment. It accepts only `127.0.0.1:57507/fleet_control_test`, creates a fresh schema on every start and binds only to `127.0.0.1`. `src/central/cooperative-service.ts` is the persistent entry point for deployment.
- `src/central/main.ts` (legacy entry point) also binds only to `127.0.0.1` and takes `CENTRAL_DATABASE_URL`, `CENTRAL_CREDENTIALS_FILE`, `CENTRAL_PORT` and optional TLS files. The owner decided not to migrate legacy data (option A in [legacy-migration-proposal.md](legacy-migration-proposal.md)).
- Both entry points have optional TLS. No certificate exists for `.15`.
- `.15` runs a production fleet (`tv-*`). Its sessions must not be attached to, sent to or killed.
- Access: the Mac mini (`.4`) reaches `me@192.168.50.15:27022` and, since 2026-11-13, `root@192.168.50.15:27022` with its key. The owner asked to use root and switch to `me` (`su - me`). Host key: ED25519 `SHA256:6zSQESslMUUOVv+athgHB99I0qvvfOtPCx4mOev+hWc`.

## Inventory of .15 (read-only, 2026-11-12)

Collected over SSH as `me` (port 27022) on 2026-11-12, when `root` still refused the key (it works since 2026-11-13, see Access above). Nothing was changed.

- Manjaro Linux, kernel 6.12, x86_64, 12 CPUs, 78 GiB RAM, up 10 days.
- The root filesystem was full on 2026-11-12. On 2026-11-13 it had 55 GB free (94% used).
- Bun 1.4.0 at `/usr/bin/bun` (the Mac mini runs 1.4.4). Docker 29.7.2; `me` is in the `docker` group. tmux, git and gh are installed. No PostgreSQL client or server on the host.
- About 20 containers already run, including CLIProxyAPI (`cli-proxy-api`, port 8317), Coolify's Caddy proxy on ports 80 and 443, and a Tailscale gateway. No PostgreSQL container.
- Port 4873 is taken by verdaccio, so the service uses 4881. Port 57507 and the other test ports are free. User systemd units already run (`cwelux-agent`, `cc-connect`, `sil-web`), so a user unit for this service fits the existing setup.

## Steps

1. **Access and inventory.** Done, see above.
2. **Persistent cooperative entry point (code, local).** Done: `src/central/cooperative-service.ts` with `init`, `provision`, `activate` and `serve`. It opens the existing schema `fleet_cooperative_v1` with the restricted role `fleet_cooperative_runtime`, reads database URLs from private files and keeps the schema guard and the ambient `PG*` check. A restart does not rotate the supervisor incarnation; only `activate` does. Tested locally with compose (setup, synthetic claim cycle, container restart, second cycle on the same incarnation).
3. **Listener exposure (decision).** Both entry points bind only to `127.0.0.1`. Options: keep loopback and reach it over an SSH tunnel from the MacBook (no code change, recommended first), or allow a LAN bind with TLS required (code change and a review).
4. **PostgreSQL on `.15`.** Approved. The compose file runs PostgreSQL 17 on an internal network with no published port; data lives in `pg/` of the private state directory, which only the PostgreSQL container mounts. Backups are not automated yet: `scripts/central-backup.ts` expects TLS and does not fit this database as is. Until a backup path exists, a backup is a manual `pg_dump` from the container to a second machine, and it counts only after a checked restore into a throwaway database.
5. **Certificates (owner).** Proposal: the same as `.4`. The owner's mkcert CA on the MacBook issues a certificate for `IP:192.168.50.15`; the key is copied to `.15` once, mode 0600, owned by the service user. Not needed if step 3 stays on an SSH tunnel.
6. **Service.** Docker compose with `restart: unless-stopped`, no systemd unit; both containers run as `me`'s uid, secrets in private 0600 files, each container mounting only its part of the state directory. Separate from the production fleet's tmux sessions.
7. **Verification.** Operator submit, a synthetic supervisor claim and reports, operator inspection and a stale-incarnation rejection against `.15`, then one real-agent run as in `scripts/real-agent-smoke.ts` on a scratch session, never on `tv-*`.

Rollback at every step: `docker compose down` in `deploy/cooperative` stops both containers and keeps the state directory (a bind mount, not a volume). Delete the state directory only after a checked backup. Nothing in this plan changes the production fleet.
