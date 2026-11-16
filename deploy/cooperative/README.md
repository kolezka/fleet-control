## Persistent cooperative central (docker compose)

This runs the cooperative central with its own PostgreSQL 17. It serves the operator API and MCP
endpoint on host loopback only. Supervisors pull work through the host adapter
(`src/host-agent/cooperative-main.ts`). Nothing here sends input to a terminal, and nothing retries
or requeues work.

### Setup (once per host)

```bash
deploy/cooperative/setup.sh /home/me/.local/state/fleet-cooperative 4881 <host id>
```

Steps, each skipped when its output already exists:

1. Writes `deploy/cooperative/.env` (state directory, port, your uid and gid, supervisor host id).
   A rerun with other settings stops.
2. `init` writes secrets into the state directory, each file exclusive and mode 0600, never printed:
   - `pg/password` and `pg/data`: only the PostgreSQL container mounts `pg/`.
   - `admin/admin-url`: superuser URL, mounted only by the one-shot `admin` service.
   - `service/credentials.json` (token hashes only) and, after provision, `service/runtime-url`:
     the only files the listener sees, mounted read-only.
   - `client/`: operator and local tokens, `adapter.json` and, after activate, `incarnation.json`.
     These stay on the host for the operator and the host adapter.
3. Starts PostgreSQL. It has no published port and sits on an internal network.
4. `provision` creates schema `fleet_cooperative_v1` and the restricted role
   `fleet_cooperative_runtime` in one transaction and writes `service/runtime-url` before it commits.
5. `activate` enrolls the supervisor and writes `client/incarnation.json`.
6. Starts central on `127.0.0.1:<port>`.

If a step fails, the script names it. Fix the cause and run the same command again.

The state directory must be visible to the Docker daemon. On Colima (macOS) that means somewhere
under your home directory, not `/tmp`.

### Day to day

- `docker compose -f deploy/cooperative/compose.yaml restart`: a restart keeps the incarnation, so
  claims made before it stay reportable. Central gets 30 s to drain before Docker kills it.
- Run the host adapter with
  `COOPERATIVE_ADAPTER_CONFIG_FILE=<state>/client/adapter.json bun src/host-agent/cooperative-main.ts`.
  The adapter accepts plain HTTP only to loopback. The
  deployment relies on that: central is published on host loopback only.
- Check the installation with `bun scripts/cooperative-compose-smoke.ts <state> [--restart]`. It
  submits synthetic commands and claims them as the real supervisor. It refuses to start while that
  supervisor has queued commands. Do not run it while the supervisor's own adapter is live: both
  would race for the same claims.

### Replacing the supervisor incarnation

Run this only when the old supervisor process is gone or must be fenced:

```bash
mv <state>/client/incarnation.json <state>/client/incarnation.old.json
docker compose -f deploy/cooperative/compose.yaml run --rm admin activate
```

Then restart the host adapter: it reads the incarnation only at startup. The old incarnation can no
longer claim or report. Its claimed commands stay claimed. An operator settles them through
`POST /api/commands/:id/cooperative/settlement`; nothing requeues them.

### Backups

```bash
deploy/cooperative/backup.sh <new archive path> --check-restore
```

It dumps database `fleet` from the postgres container (custom format, mode 0600, never
overwrites) and lists the archive with `pg_restore`. With `--check-restore` it restores the archive
into a throwaway database on the same server and compares `fleet_cooperative_v1` with the live
database: table names, row counts and a digest of the row contents of every table. Then it drops
the throwaway database. It prints table names, counts and digests, never rows. Exit code 3 means
counts or contents differ, usually because commands arrived after the dump. The output names the
tables; run it again when idle.

The check also prints one value for the whole restored schema, whether or not live matches:

```
restored fingerprint <sha256> schema fleet_cooperative_v1 tables <n>
```

To check the copy on a second machine, restore the archive there into a throwaway database and run
`schema-fingerprint.sql` (the query `backup.sh` uses, so keep the two files together) with psql:

```bash
createdb restore_check
pg_restore -d restore_check --exit-on-error --no-owner --no-privileges <archive>
psql -X -d restore_check -f deploy/cooperative/schema-fingerprint.sql
dropdb restore_check
```

The last line, `fingerprint <sha256>`, must equal the value `backup.sh` printed. With PostgreSQL in
a container, prefix the tools with `docker exec -i <container>`, add `-U postgres`, and give
`pg_restore` and `psql` their file on stdin (`< <archive>`, `< deploy/cooperative/schema-fingerprint.sql`)
in place of the file argument. The query only reads. It works on any database: add
`-v schema=<name>` for another schema. The query pins the settings that change how values print,
but compare between servers of the same PostgreSQL major version.

The check does not compare grants, sequences or table definitions, and the archive is not a backup
until a second copy sits on another machine. Nothing schedules this script. There is no restore
script: restoring over a live installation needs a stopped stack and a human decision.

### Recovery after a crash

- **During `init`**: nothing is in the database yet. Remove `pg/`, `admin/`, `service/` and
  `client/` and run setup again.
- **During `provision`**: `runtime-url` is written before COMMIT. If it exists but the role does not
  (crash between the write and COMMIT), delete `service/runtime-url` and run setup again. If the role
  exists without the file, set a new password as the superuser
  (`ALTER ROLE fleet_cooperative_runtime PASSWORD ...`) and write the matching URL to
  `service/runtime-url` with mode 0600.
- **During `activate`**: an empty `client/incarnation.json` may remain, and the previous incarnation
  may already be fenced. Delete the empty file, run `activate` again and restart the host adapter.

### Persistent adapters and tailnet access

The adapter always listens on `127.0.0.1`. Set `COOPERATIVE_ADAPTER_PORT=4882` for a stable MCP URL;
omitting it retains the disposable random port. The private adapter config accepts an HTTPS central
URL with normal certificate verification, or HTTP to numeric loopback only. No redirects are followed.

On Linux, include `adapter.compose.yaml` after `compose.yaml` and explicitly start the `adapter`
profile. It uses host networking to bind host loopback, mounts only the adapter config and incarnation,
and gets 40 seconds to drain. It does not run an agent. On macOS, substitute `__BUN__`, `__CODE__` and
`__STATE__` in `adapter.launchd.plist` with absolute paths before installing it in LaunchAgents. Use a
stable code directory, not a temporary worktree. Keep the private config and incarnation mode 0600.
Restarting either adapter reuses its incarnation; it does not activate a replacement.

For Tailscale Serve, keep central published on host loopback. Set `COOPERATIVE_EXTERNAL_HOST` to the
exact verified tailnet DNS name and port, then recreate only central. Serve terminates HTTPS and
preserves Host; central must explicitly allow that authority. No forwarded header grants access and
bearer authentication remains required. Never use Funnel. Add only the new Serve port and verify
other configuration is unchanged; rollback removes only that port.

Each host needs its own supervisor principal, bearer, local bearer and incarnation. Do not run init,
provision or setup again to add a host. Extend the hashed credentials file with the new principal,
activate explicitly for that host/session into a new private incarnation file, and restart central to
load the new credentials. Never reuse or move another host's incarnation file. Do not rotate an
incarnation merely to restart an adapter.

### Waking the supervisor

Without a running agent nothing claims a queued command. `src/host-agent/waker.ts` closes that gap
without polling by the agent and without typing into any terminal:

1. It calls the MCP tool `cooperative_wait` through the local adapter. Central holds the call for up
   to 20 seconds and answers `{ "pending": true }` as soon as this host and session have a queued
   command. The answer carries no command id or text and claims nothing; a replaced incarnation is
   refused like a claim.
2. When work is waiting it starts the configured agent command and waits for it to exit. The agent
   claims and reports itself with `cooperative_claim` and `cooperative_report`.
3. Then it waits again. One agent runs at a time; it is never killed or restarted for an outcome. An
   agent that fails or exits within five seconds is started again only after a pause, and wait errors
   back off up to a minute.

A new command therefore reaches an idle host within about a second plus the agent's start time.

Config, a private 0600 file named by `COOPERATIVE_WAKER_CONFIG_FILE`:

```json
{
  "adapterUrl": "http://127.0.0.1:4882/mcp",
  "localToken": "<the adapter's local token>",
  "command": ["/absolute/path/to/agent", "..."],
  "waitSeconds": 20
}
```

`command[0]` must be absolute. The agent gets no token from the waker; give it its own MCP config
pointing at the same adapter, with the same local token, as `scripts/real-agent-smoke.ts` does for
Claude Code (`--mcp-config`) and DSH (`dshPatch`). Tell it to claim until the queue is empty and
then exit. Run the waker as its own user service next to the adapter (launchd on macOS, a systemd
user unit on Linux). It is not installed on `.4` or `.15`; doing so starts real agents and needs
the owner's approval.

### Limits

- Central remains HTTP on host loopback behind the optional tailnet HTTPS proxy.
- Backups are manual (`backup.sh`, above) and not scheduled. `scripts/central-backup.ts` expects
  a TLS connection and does not fit this database.
- The listener joins the `published` network only for its port mapping; it has outbound access it
  does not need.
- This is cooperative fencing between trusted processes, not a security boundary against the
  database owner.
