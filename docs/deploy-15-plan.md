# Deployment plan for 192.168.50.15

Status: deployed on two hosts with tailnet HTTPS, 2026-11-13. On 2026-11-13 the owner approved the persistent cooperative entry point and PostgreSQL on `.15`, and asked for docker compose. Steps 2, 4 and 6 are [deploy/cooperative](../deploy/cooperative/README.md); open items are listed under Deployment below.

## What exists today

- `src/central/cooperative-main.ts` is a disposable experiment. It accepts only `127.0.0.1:57507/fleet_control_test`, creates a fresh schema on every start and binds only to `127.0.0.1`. `src/central/cooperative-service.ts` is the persistent entry point for deployment.
- `src/central/main.ts` (legacy entry point) also binds only to `127.0.0.1` and takes `CENTRAL_DATABASE_URL`, `CENTRAL_CREDENTIALS_FILE`, `CENTRAL_PORT` and optional TLS files. The owner decided not to migrate legacy data (option A in [legacy-migration-proposal.md](legacy-migration-proposal.md)).
- Both entry points have optional TLS. The approved deployment now uses a Tailscale Serve certificate and private tailnet HTTPS endpoint; the application listener stays on loopback.
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
3. **Listener exposure.** Done with owner approval: Tailscale Serve HTTPS on port 4881 proxies to `127.0.0.1:4881`. The application still binds only to loopback. Existing Serve routes remain unchanged; no public Funnel.
4. **PostgreSQL on `.15`.** Approved. The compose file runs PostgreSQL 17 on an internal network with no published port; data lives in `pg/` of the private state directory, which only the PostgreSQL container mounts. Backups are manual with `deploy/cooperative/backup.sh <archive> --check-restore` (dump, listing, restore into a throwaway database with table and row-count comparison). Nothing schedules it, and an archive counts as a backup only once a second copy is on another machine.
5. **Certificates.** Tailscale Serve terminates HTTPS with its managed certificate. The `.4` adapter verified the certificate chain without a custom CA. No mkcert key transfer is needed.
6. **Service.** Docker compose with `restart: unless-stopped`, no systemd unit; both containers run as `me`'s uid, secrets in private 0600 files, each container mounting only its part of the state directory. Separate from the production fleet's tmux sessions.
7. **Verification.** Operator submit, a synthetic supervisor claim and reports, operator inspection and a stale-incarnation rejection against `.15`, then one real-agent run as in `scripts/real-agent-smoke.ts` on a scratch session, never on `tv-*`.

## Deployment (2026-11-13)

- Initial release: `22d0dd5` copied with `git archive` to `/home/me/fleet-cooperative`. That directory is retained, not the active release. The current versioned release is listed below. Updates must preserve the existing private state, Compose project identity and external Host configuration; do not re-run setup or activation.
- State: `/home/me/.local/state/fleet-cooperative`, port 4881, supervisor host id `me-desktop`, session `supervisor`. `setup.sh` ran every step without errors.
- Listener on `127.0.0.1:4881` only. The central container sees only `/state/service` (credential hashes, runtime URL).
- Verified on `.15`: `scripts/cooperative-compose-smoke.ts --restart` passed both cycles (submit, claim, accepted/running/completed, inspection, container restart, same incarnation claims again). Then the incarnation was replaced with `activate`: an adapter on the old incarnation could not claim, the new one claimed and reported a synthetic command, and inspection showed the active claim with all three events. The old incarnation file is kept as `client/incarnation.old.json`.
- Two-host rollout (PR #58, 2026-11-13): release `86585c0` (merged as `451fa60`) lives at `/home/me/fleet-cooperative-releases/86585c0`; the earlier directory remains for rollback. Central and the desktop adapter now run from that release. Include both `deploy/cooperative/compose.yaml` and `deploy/cooperative/adapter.compose.yaml` for adapter operations. The image before this rollout is retained as `fleet-cooperative-central:before-two-host`.
- Approved Tailscale Serve exposes `https://local-arch.tail4a51cb.ts.net:4881` only inside the tailnet, forwarding to host loopback. Central allows exactly that external Host authority, not forwarded headers. Public certificate verification from `.4` passed; unauthenticated API access returned 401. Existing Serve settings were preserved; no Funnel. Rollback only this exposure with `tailscale serve --https=4881 off`. The earlier mkcert proposal is not needed for this path.
- Persistent adapters listen only on `127.0.0.1:4882`: Compose on `.15` (`me-desktop/supervisor`), launchd label `pl.raqz.fleet-cooperative-adapter` on `.4` (`mac-mini-mariusz/supervisor`). The mini uses versioned code at `/Users/me/Development/fleet-cooperative-adapter-releases/86585c0` and private state at `/Users/me/.local/state/fleet-cooperative-adapter`. Each has its own supervisor bearer and incarnation; adding the mini did not rotate the desktop incarnation.
- Synthetic operator submit, claim through each running adapter, accepted/running/completed reports and operator inspection passed on both hosts, then passed again after restarting central and both adapters. Incarnation file checksums stayed unchanged; the database has exactly two active identities. No real agents or production fleet sessions were used.
- Real DSH on `.15` (lead-verified, 2026-11-13): DSH `0.2.2-rc.1` with isolated Node `24.22.3` read a fixture in private `/mnt/data/fleet-control-smoke` through CLIProxyAPI `http://127.0.0.1:8317/v1`, the persistent desktop adapter `127.0.0.1:4882` and tailnet central. Command `cmd-2e328ebb-bbc1-411c-8f8c-136a5681ef65` reported accepted/running/completed on the active incarnation, with exact detail `2: host-b, host-d`; the file stayed unchanged, exit was 0, final status was completed and no token leaked (about 13 seconds). See [full scope and cleanup](central-server-status.md#real-dsh-on-15-2026-11-13). No production `tv-*` sessions were touched.
- Open: no automated backup or second archive copy. The legacy `.4` service and UI remain separate and unchanged; UI integration and agent-fleet idle wakeup are not verified.

Rollback at every step: `docker compose down` in `deploy/cooperative` stops both containers and keeps the state directory (a bind mount, not a volume). Delete the state directory only after a checked backup. Nothing in this plan changes the production fleet.
