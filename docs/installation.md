# MacBook and workstation installation

Status: target installation split plus the service configuration on `main` (section "Running the service"). Chosen hosts: 192.168.50.4 (macOS, user `me`) and 192.168.50.15 (Manjaro, user `me`). A test-fleet service is installed on `.4` (see "Installed on 192.168.50.4" below). No host service is installed on `.15`; the cooperative central and adapter there are covered in [deploy-15-plan.md](deploy-15-plan.md).

## Component split

| Component | MacBook | Workstation |
| --- | --- | --- |
| Terminal Deck | Browser loads the UI | Hosts the web application |
| Ghostty-based terminal | Browser loads ghostty-web as part of the UI | Provides authenticated WebSocket and PTY transport |
| Local assistant | Existing assistant client, configured for remote Fleet Control MCP | Exposes the MCP endpoint through the service |
| Fleet Control service | Not required for normal use | Bun service for API, MCP, commands, requests and events |
| Supervisor and workers | Not required locally for remote execution | Agent CLI/harness, prompts, routing and permissions |
| agent-fleet | Not required on the Mac for client-only operation | CLI, fleet configuration and watchdog |
| phased-delivery | Not required on the Mac for client-only operation | Skill, repository profile, phase records and reports |
| Repositories | Optional for separate local development | Checkouts and isolated worktrees for execution |
| Build/test tooling | Optional for local development | Tools required by each managed repository |
| Durable state | No authoritative run state | Commands, requests, decisions, checkpoints and logs |
| Process supervision | No always-on dependency | OS service manager and explicit recovery policy |

Existing plugins on the Mac can remain for other work. This split does not call for uninstalling them.

## MacBook minimum

- A browser that can run the chosen web terminal renderer.
- Network access to the workstation service.
- Client authentication for the browser and local assistant.
- The existing local assistant client with a registered remote MCP connection.

A local Bun server, agent-fleet runtime and native Ghostty installation are not required for browser-only operation. Native Ghostty or another terminal remains optional for administrative SSH. A thin operator CLI is optional, not a second supervisor.

The local assistant still needs its own normal model authentication. That is distinct from workstation execution credentials and Fleet Control client access.

## Workstation runtime

- Bun and the future Fleet Control service, including web assets and host adapters.
- The selected agent CLI/harness and its own model-provider access.
- agent-fleet, phased-delivery and the configured model-routing rules used by those sessions.
- tmux and the shell/tools required by the pinned fleet CLI version.
- Git, repository credentials and project-specific dependencies, compilers, test runners or emulators.
- Storage for worktrees, phase records, service state and logs.
- A suitable OS service manager, such as systemd on Linux or launchd on macOS, after the host OS is established.

This is not a complete package-manager dependency list. Derive exact packages and versions from the selected host and pinned integrations. Do not install unrelated SDKs or build tools simply because another repository uses them.

The workstation does not inherently need to host an LLM locally. It can run agent clients against configured model services. Model hosting is a separate choice.

## Credentials and network

Workstation model and repository access must continue when the MacBook disconnects. Do not rely solely on an active laptop tunnel, SSH-agent forwarding or a credential process running on the Mac.

Choose an authenticated private-network or secured HTTPS route before exposing the service. The exact LAN, VPN, DNS and TLS setup remains open. Do not expose the terminal bridge anonymously or treat a private IP as authorization. Validate WebSocket origins and bind every terminal connection to an authorized session.

Never copy credentials into these docs, run reports, screenshots or browser code. The browser receives client authorization, not the workstation's model-provider keys or SSH private keys.

## Adding a host from the MacBook gateway

Start the gateway with `FLEET_CONTROL_ENROLL=1` and open `/add-host` (also linked in the sidebar). With this flag the config may start as `{"hosts": []}`, so the first host is also added from the page and no token is copied by hand; without it an empty host list is refused. Fill in the host's Tailscale address (`https://<name>.<tailnet>.ts.net:<port>`; leave the port out for 443, which only connect supports, since a fresh install runs a user service that needs a port from 1024 up), the gateway's name on that host and the service folder, then press "Make token and command". Run the shown command on the host (or let the gateway run it over SSH) and press Check. The same flag lets the page give a host a new gateway token (the host gets only its hash) and remove a host, with or without revoking the gateway's line on it.

- **Connect** is for a host whose service already runs. The command runs `bun scripts/enroll.ts connect` in the service folder; it adds one hash line with the `operator` role and sends SIGHUP. Nothing restarts. The service folder must hold a release with `scripts/enroll.ts` (this branch or later). On an older release the command prints that and changes nothing, so update the host first (see "Update the service"); updating restarts it once.
- **Fresh install** clones the code to a new folder, checks out the chosen ref, installs it, makes an empty fleet and starts a new service. Make the Tailscale certificate first (`sudo tailscale cert --cert-file <cert> --key-file <key> <name>`, then `chown` both to the service user); the command refuses without it.

The token stays in `token-<id>` next to the gateway config. The host only gets its hash. Hosts being added are kept in the gateway's memory only. After a gateway restart, adding the same id again answers that `token-<id>` already exists, with its full path. If no host in the config uses that file, remove it and start again; if the command already ran on the host, revoke that name there too (`bun scripts/tokens.ts revoke <name> <tokens-file>`).

## First-run and recovery gates

Before live use:

1. Identify the host, execution user and managed repositories.
2. Install pinned tools and establish independent host authentication.
3. Have the owner complete workspace trust where the agent CLI requires it. Fleet automation must not answer that prompt on their behalf.
4. Configure allowed actions, budgets, stop time and escalation boundaries.
5. Verify a read-only session attachment before granting input control.
6. Test MacBook disconnect/reconnect, then supervisor replacement and workstation restart as separate scenarios.

Autostart, watchdog behavior and restart policy must be reviewed before enabling them. Do not automatically resume ambiguous in-flight commands after a restart. Reconcile command and runtime identities first.

A copied database is not a verified backup. `bun scripts/host-backup.ts <state.db> <new file>` takes one consistent snapshot while the service runs, writes it to a new 0600 file (it never overwrites), runs `integrity_check` on the copy and compares every table row by row with the snapshot, then prints the SHA-256. The copy opens as a plain database without `-wal` or `-shm` files. It does not schedule backups or keep a second copy: copy the file to another machine and compare the checksum there. Backup location and schedule remain deployment decisions.

On the second machine, `bun scripts/host-restore-check.ts <backup file> <sha256>` compares the checksum, copies the file to a temporary directory and opens the copy with the service's own stores. It reads sessions, every command with its events, runs, requests and request events, and fails if opening changed any row. It names any table the service would add to an older backup. The backup file is not written and nothing is restored over a live database; an actual restore is still a stopped-service file copy decided per host.

## Running the service

Environment for `bun index.ts`:

| Variable | Meaning |
| --- | --- |
| `FLEET_CONF` | Required. The agent-fleet `fleet.conf` of the fleet on this host. |
| `READONLY_FLEET_BIN` | Explicit CLI override, then `FLEET_BIN`; default is the pinned `vendor/agent-fleet/scripts/fleet`. Initialize with `git submodule update --init --recursive`. See [dependency maintenance](agent-fleet-dependency.md). |
| `FLEET_CONTROL_DB` | SQLite file. Default `:memory:`, which loses commands and requests on restart. |
| `PORT` | Default 4871. |
| `FLEET_CONTROL_HOST` | Bind address. Default `127.0.0.1`. Any other value requires `FLEET_CONTROL_TOKENS`; the service refuses to start without it. |
| `FLEET_CONTROL_TOKENS` | Tokens file: `<principal> <sha256 hex> [operator\|agent\|viewer]` per line; no role means `agent`. Only hashes live on the host. Principal names and token hashes must both be unique; a duplicate prevents startup. Auth copies configured hashes at construction; changing an in-memory map later does not rotate or revoke credentials. |
| `FLEET_CONTROL_ALLOWED_HOSTS` | Extra `host:port` values accepted on `/mcp` (DNS rebinding protection), e.g. a Tailscale name. The bind address is added automatically. |
| `FLEET_CONTROL_TLS_CERT`, `FLEET_CONTROL_TLS_KEY` | Optional PEM files. Without them traffic is plain HTTP, so tokens cross the network in clear text. Use Tailscale (encrypted) or add TLS before using LAN. |
| `FLEET_CONTROL_TAILNET_HOST`, `FLEET_CONTROL_TAILNET_NAME`, `FLEET_CONTROL_TAILNET_TLS_CERT`, `FLEET_CONTROL_TAILNET_TLS_KEY` | Optional second listener, on the host's Tailscale IP (100.64.0.0/10 or fd7a:115c:a1e0::/48; loopback is also accepted, for tests; anything else is refused), same port, same state, tokens and terminal viewer cap. All four or none; needs a fixed `PORT`. It needs auth and its own certificate for its MagicDNS name (`tailscale cert <name>`); the certificate must name `FLEET_CONTROL_TAILNET_NAME`, the key must match, and the host must differ from `FLEET_CONTROL_HOST`. The name is added to the `/mcp` allowed hosts. Clients reach it as `https://<name>:<port>/`. Tailscale certificates last 90 days; renew with `tailscale cert` and restart. An expired tailnet certificate stops the whole service, LAN listener included. If the second listener cannot bind, the service stops and exits 1. The login cookie is per origin, so a browser signs in again on the tailnet name. |
| `FLEET_CONTROL_AGENT_ROOTS`, `FLEET_CONTROL_AGENT_MODELS` | Optional managed Claude Code agents. Roots is a colon list of plain absolute folders; an agent's working folder must be an existing folder inside one (symlinks are resolved first; the root itself is refused). Models is a comma list of Claude Code aliases, default `sonnet,opus,haiku`. Needs `FLEET_CONTROL_TOKENS`; only the operator role may start or stop. The service writes `fleet-control-agents.conf` in `FLEET_DIR` and one include line at the end of `fleet.conf`, writes `autonomy.txt` there only if it is missing, and marks each working folder as trusted in `~/.claude.json`. Agents run with `--dangerously-skip-permissions`. `claude` must be on the service's `PATH` and `CLAUDE_BIN` unset (the watchdog finds Claude by the process name `claude`). Not for `REMOTE_SSH` fleets. `FLEET_CONF` must be `$FLEET_DIR/fleet.conf`, and the fleet's `watchdog.sh` must come from agent-fleet 0.5.0 or later (`agent_overrides`; `fleet sync` copies it); otherwise the service refuses to start agents. A watchdog that is already running keeps its agent list: restart it after stopping an agent, or it recreates the agent. The gateway's host token must be `operator` for the panel to start agents. |
| `FLEET_CONTROL_AGENT_DSH_MODELS` | Optional. A comma list of DSH `provider/model` pairs (for example `deepseek-official/deepseek-flash`); when set, the panel can also start DSH agents through agent-fleet's `dsh-agent.mjs`. Each DSH agent gets `<name>.dsh.yml` (mode 0600) in `FLEET_DIR`: a DSH patch that turns the credentials store back on (the headless profile has it off) and sets the model. No key is copied; DSH reads its own store. DSH agents run `dsh --profile headless --permission-mode workspace-write` in the agent's folder and get no Claude Code trust entry. The headless profile keeps `approval: ask` and has no one to answer, so a step that needs approval fails closed. `workspace-write` limits writes, not reads or network: the agent can read the credentials DSH uses. The patch file stays after a stop (it holds only the model). A watchdog started before `fleet sync` keeps the old code and would treat a DSH row as Claude Code when it replaces the agent; restart it after the sync. Needs `dsh` and Node 20 or later as `node` on the service's `PATH` (or `DSH_BIN`, `NODE_BIN`), and agent-fleet 0.6.0 or later in `FLEET_DIR` (per-agent `AGENT_KIND`); otherwise a DSH start is refused before anything is written. |
| `FLEET_CONTROL_ADMIN`, `FLEET_CONTROL_SERVICE_LOG` | Optional fleet section on the page. `FLEET_CONTROL_ADMIN=1` lets an operator read and save `fleet.conf`, read the last lines of the watchdog log (`fleet log`) and of the service log, and restart one session on the fleet's own tmux socket (`tmux kill-session`, then the start command an operator saved for that session on the page, run with `tmux new-session` in its saved folder, or `fleet start <session>` for a `fleet.conf` session without one; managed `fc-` agents are refused; saved commands are kept in the state DB). Needs `FLEET_CONTROL_TOKENS`. A save needs the SHA-256 the file was read with and the typed word `fleet.conf`; it is refused when the file changed since, when `bash -n` fails, when the current or the new file does not load the way agent-fleet loads it (`set -euo pipefail`: any failing command, an unset variable, missing `FLEET`/`FLEET_DIR`, or a `return`/`exit` before the end), when the managed agents include line is gone or no longer last, when a managed agent would drop out, or when `FLEET`, `FLEET_DIR`, `FLEET_TMUX_SOCKET` or `REMOTE_SSH` would change. Each save first copies the old file to `fleet.conf.bak-<time>-<id>` beside it (same mode); backups are not pruned. A save does not restart anything. `FLEET_CONTROL_SERVICE_LOG` is an absolute log file (launchd `StandardOutPath`) or `journal:<unit>` for a systemd user unit; without it the service log is not offered. Not for `REMOTE_SSH` fleets. The same switch lists the tokens file (names and roles) and lets an operator rotate or revoke other lines; see "Tokens from the page" in `docs/implementation-status.md`. |
| `FLEET_CONTROL_SETTINGS` | Optional. Absolute path of the service settings file; default `settings.json` beside `FLEET_CONTROL_TOKENS`. The page (with `FLEET_CONTROL_ADMIN=1`) writes it; the service reads it at start, and its keys (`agentRoots`, `agentModels`, `agentDshModels`, `agentMcpUrl`, `input`) go over `FLEET_CONTROL_AGENT_ROOTS`, `FLEET_CONTROL_AGENT_MODELS`, `FLEET_CONTROL_AGENT_DSH_MODELS`, `FLEET_CONTROL_AGENT_MCP_URL` and `FLEET_CONTROL_INPUT`. It is read only with `FLEET_CONTROL_ADMIN=1` and keeps only the settings that differ from the plist or unit. A file that does not load, or that the start could not use (for example input on a `REMOTE_SSH` fleet), is skipped with a log line. |
| (restart and update) | With `FLEET_CONTROL_ADMIN=1` and a service started by launchd or systemd, the page restarts the service and updates it to a GitHub release package; the updater writes jobs to `updates/` and backups to `rollback-<short>/` beside `FLEET_CONTROL_TOKENS`. Needs `tar` and, on Linux, `systemd-run`. The service folder must be the one the plist or unit starts. |
| `FLEET_CONTROL_AGENT_MCP_URL` | Optional. This host's MCP address as an agent on this host reaches it: `https://<tailnet name>:<port>/mcp` or `http://127.0.0.1:<port>/mcp`. When set, an operator can start a Claude Code agent as an orchestrator for a phased run. Its start adds a line `<agent name> <hash> agent` to `FLEET_CONTROL_TOKENS` (under the tokens lock, loaded at once) and writes `<name>.mcp.json` (mode 0600) in `FLEET_DIR` with the token, passed with `--strict-mcp-config --mcp-config`, so this is the agent's only MCP server. The agent role may register a run, update phases and ask, never answer. A stop, a failed start and the next service start remove the line and the file; a new start under the same name replaces it. Names starting with `fc-` are kept for managed agents: do not use them for hand-made tokens (`scripts/tokens.ts` refuses other roles for them). Any tokens change for an agent also loads earlier hand edits of the file at once. Its task file gets a short brief on how to ask for approval after each phase. |

Clear `NO_COLOR` in the service environment: agent-fleet misreads Claude Code's input line when it is set (docs/bugs/agent-fleet-no-color-user-typing.md).

Tokens: `bun scripts/new-token.ts <principal> <tokens-file> [role]` prints a token once and appends its hash line to the tokens file (without the file argument it prints the line instead). One principal per client, e.g. `macbook-session`, `web-mariusz`, `orchestrator`. The principal is recorded as the actor of every command, answer and phase write, and replaces any actor name a client sends. Roles: `operator` for the human's consoles (gateway, browser, DSH panel), the only role that may answer a request; `agent` (the default) for orchestrators and workers; `viewer` for read-only access. Set or change a role with `bun scripts/tokens.ts role <principal> <role> <tokens-file>` and send the service SIGHUP. Revoke with `scripts/tokens.ts revoke`.

Clients:

- Browser: open `http://<host>:4871/login`, paste a token. It is stored in an HttpOnly, SameSite=Strict cookie (Secure with TLS), so page scripts cannot read it.
- MCP from the MacBook (Claude Code): `claude mcp add --transport http fleet-control-mini http://<host>:4871/mcp --header "Authorization: Bearer <token>"`. Keep the token out of shared config files.

## Installed on 192.168.50.4 (2026-11-09, approved by the owner)

LaunchAgent `pl.raqz.fleet-control` for user `me`, bound to `192.168.50.4:4871` with TLS and tokens. Since 2026-11-19 (release `d48acd7`) it also listens on `100.64.0.6:4871` as `https://mac-mini-mariusz.tail4a51cb.ts.net:4871/` with a `tailscale cert` certificate in `~/.config/fleet-control/tailnet-tls/` (valid to 2027-02-15, not renewed automatically). The earlier owner decision "nothing on Tailscale" was changed by the owner on 2026-11-19 for the MacBook gateway. It serves a **test fleet only**: socket `fleet-fctrl-test`, one session `probe-shell` running `cat`. Since release `65f608c` an operator may start managed Claude Code agents (`fc-*`) in folders under `~/fleet-agents` (`FLEET_CONTROL_AGENT_ROOTS`); since `608f243` also DSH agents with the models in `FLEET_CONTROL_AGENT_DSH_MODELS` (the plist `PATH` ends with `/Users/me/.local/bin` for `node`); none runs now. No production session is attached. The test fleet's tmux server must be started from an existing folder (it was restarted from `~/.local/share/fleet-control/test-fleet` on 2026-11-19): a server whose folder was deleted opens new panes there and Claude Code will not start.

| Item | Path on `.4` |
| --- | --- |
| Service checkout (since 2026-11-21 04:20: `git archive` of `main` at `69a08a4` plus `vendor/agent-fleet` `c916b8d`, adding `FLEET_CONTROL_ADMIN=1` and `FLEET_CONTROL_SERVICE_LOG`; `6526300` at 04:05; on 2026-11-20 21:57 `239b084` with `FLEET_CONTROL_INPUT=1` and `FLEET_CONTROL_AGENT_MCP_URL`; at 16:26 `608f243`; on 2026-11-19 20:23 `65f608c` plus `5c57a62`; earlier that day `d48acd7`; before that `ad23ff2` and `6836a15`; on 2026-11-16 `05b18aa` plus the pinned `vendor/agent-fleet` files, no `.git`; the commit is in `RELEASE`; `59965a3` earlier on 2026-11-16, `735c1f8` from 2026-11-15 before that) | `~/Development/fleet-control-service` |
| Plist | `~/Library/LaunchAgents/pl.raqz.fleet-control.plist` |
| fleet.conf (must sit in `FLEET_DIR`: agent-fleet's `watchdog.sh` reads `$FLEET_DIR/fleet.conf`) | `~/.local/share/fleet-control/test-fleet/fleet.conf` |
| State database | `~/Library/Application Support/fleet-control/state.db` |
| Tokens (hashes only), certificate, key, public CA, orchestrator token | `~/.config/fleet-control/` (dir 700, key and tokens 600) |
| Log | `~/Library/Logs/fleet-control.log` |
| fleet CLI (since 2026-11-15 the pinned copy inside the checkout; `READONLY_FLEET_BIN` was removed from the plist) | `~/Development/fleet-control-service/vendor/agent-fleet/scripts/fleet` |

Certificate: issued by the MacBook's existing mkcert CA (`mkcert me@MacBook-Pro-me.local`, already trusted in the MacBook System keychain), SAN `IP:192.168.50.4`, valid until 2029-02-09. The CA private key never left the MacBook; `.4` has only the public `ca.pem` so local clients there can verify the server.

At start the service checks `FLEET_CONTROL_TLS_CERT` and `FLEET_CONTROL_TLS_KEY` (`tlsFromEnv` in `src/config.ts`): both or neither must be set, the key must match the certificate, and an expired or not yet valid certificate stops the start. Before, only one of the two set meant plain HTTP without a warning. Less than 30 days before expiry it logs a warning at each start; it does not renew anything.

To rotate: make the new pair (same CA and names), run `bun scripts/tls-check.ts <new cert> <new key>` on the host (same checks, exit 0 or a reason), keep the old files under another name, move the new ones into place and restart (`launchctl kickstart -k`). The service reads the files only at start: a hot reload is not offered, because in Bun 1.4.4 `server.reload({ tls })` returned without error but kept serving the old certificate (checked with `openssl s_client`, 2026-11-16). A token change does not need a restart (SIGHUP, see install-guide.md). The installed `.4` service has not been restarted with this check.

Principals and roles since 2026-11-19: `macbook-session` agent (MCP from the MacBook), `web-mariusz` operator (browser), `mini-orchestrator` agent (test orchestrator on `.4`), `dsh-panel` operator (DeepSeek Harness panel). Plain tokens are only in `~/.config/fleet-control/token-*` on the machine that uses them.

MacBook MCP registration (user scope, in `~/.claude.json`): `fleet-control-mini` → `https://192.168.50.4:4871/mcp` with the bearer header. `claude mcp list` reports it connected. Other Node/Bun clients need `NODE_EXTRA_CA_CERTS` pointing at the mkcert CA.

Operate:

```bash
ssh me@192.168.50.4 'launchctl print gui/$(id -u)/pl.raqz.fleet-control | grep -E "state|pid"'
ssh me@192.168.50.4 'launchctl kickstart -k gui/$(id -u)/pl.raqz.fleet-control'   # restart
ssh me@192.168.50.4 'tail -20 ~/Library/Logs/fleet-control.log'
```

Remove completely:

```bash
ssh me@192.168.50.4 'launchctl bootout gui/$(id -u)/pl.raqz.fleet-control; rm ~/Library/LaunchAgents/pl.raqz.fleet-control.plist; tmux -L fleet-fctrl-test kill-server'
claude mcp remove --scope user fleet-control-mini
# optional: rm -rf ~/Development/fleet-control-service ~/.config/fleet-control ~/.local/share/fleet-control "~/Library/Application Support/fleet-control" on .4
```

The test session is not started by launchd. After a reboot of `.4` the service comes back but `probe-shell` does not:
`tmux -L fleet-fctrl-test -f /dev/null new-session -d -s probe-shell -x 120 -y 30 "exec cat"` (with `/opt/homebrew/bin` on PATH, `NO_COLOR` unset).

Update the service (run on `.4`, as done on 2026-11-15; evidence in [implementation status](implementation-status.md)):

1. Build the new checkout beside the running one: `git archive <commit> | tar -x -C <new>`, then `git -C vendor/agent-fleet archive HEAD | tar -x -C <new>/vendor/agent-fleet` with the submodule at the pinned commit, then `bun install --frozen-lockfile` in `<new>`.
2. Copy the state database while the service runs: `bun scripts/host-backup.ts <state.db> <copy>` (on 2026-11-15 this step used `sqlite3 <state.db> ".backup <copy>"`). Keep the old plist and `watchdog.sh` too.
3. Start the new code on a loopback port against a scratch copy of that database and read `/api/commands` and `/api/requests`. Stop it again and check the port is free.
4. `launchctl bootout gui/$(id -u)/pl.raqz.fleet-control`, rename the old checkout aside, move the new one into place.
5. Run `fleet sync` with `FLEET_CONF` set, so `watchdog.sh` in the fleet directory matches the CLI.
6. `launchctl bootstrap gui/$(id -u) <plist>`. An unauthenticated `GET /api/sessions` must answer 401.

Keep the old checkout and the copies until the new release has been used. If the old checkout is removed earlier, first check that it can be rebuilt from a commit in git (compare the files, run the frozen install once) and write that commit into the rollback steps. The earlier instruction (rsync into the live directory, then `kickstart -k`) left nothing to go back to. The rollback of the 2026-11-15 update was drilled once in both directions; see the implementation status.

Starting an agent with `fleet start` at the pinned CLI needs a Claude Code footer that says `bypass permissions on` or `for shortcuts`. `--permission-mode dontAsk` and auto mode show neither, and the start then fails after 90 s.

## Installed on 192.168.50.15 (2026-11-19, approved by the owner)

systemd user unit `fleet-control.service` for user `me` on `me-desktop` (Manjaro), enabled, linger on. Release `69a08a4` in `~/Development/fleet-control-service` since 2026-11-21 04:21 (`git archive` plus pinned `vendor/agent-fleet` `c916b8d`, `RELEASE` file; `6526300` before, kept as `fleet-control-service.before-69a08a4`; `239b084` from 2026-11-20 21:58), with `FLEET_CONTROL_INPUT=1`, `FLEET_CONTROL_AGENT_MCP_URL=http://127.0.0.1:4871/mcp`, `FLEET_CONTROL_ADMIN=1` and `FLEET_CONTROL_SERVICE_LOG=journal:fleet-control`. Managed agents in `~/fleet-agents` (`FLEET_CONTROL_AGENT_ROOTS`); the unit's `PATH` starts with `/home/me/.local/bin` so the watchdog finds `claude`. Loopback `127.0.0.1:4871` without TLS and the tailnet listener `100.64.0.5:4871` as `https://local-arch.tail4a51cb.ts.net:4871/` with a `tailscale cert` certificate (`sudo tailscale cert`, owned by `me`, valid to 2027-02-05, not renewed automatically). No LAN listener. Test fleet only: socket `fleet-fctrl-test`, session `probe-shell` running `cat`; production `tv-*` sessions on the default socket are not attached.

| Item | Path on `.15` |
| --- | --- |
| Unit | `~/.config/systemd/user/fleet-control.service` |
| fleet.conf | `~/.local/share/fleet-control/test-fleet/fleet.conf` |
| State database | `~/.local/share/fleet-control/state.db` |
| Tokens (hashes with roles) and plain tokens of `local-orchestrator` (agent) and `local-operator` (operator), kept on `.15` with the owner's approval until the MacBook gateway takes the operator token | `~/.config/fleet-control/` (dir 700, files 600) |
| Log | `journalctl --user -u fleet-control` |

Operate: `systemctl --user status|restart fleet-control`. Remove: `systemctl --user disable --now fleet-control`, delete the unit, `tmux -L fleet-fctrl-test kill-server`. After a reboot the unit starts, `probe-shell` does not: `tmux -L fleet-fctrl-test -f /dev/null new-session -d -s probe-shell -x 120 -y 30 "exec cat"`.

## launchd draft (history)

A LaunchAgent for user `me` keeps the service running while `me` is logged in; a LaunchDaemon with `UserName` `me` also runs before login. The fleet's tmux server must run as the same user, so either works as long as it is `me`. Draft `~/Library/LaunchAgents/pl.raqz.fleet-control.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>pl.raqz.fleet-control</string>
  <key>ProgramArguments</key><array>
    <string>/Users/me/.bun/bin/bun</string><string>index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/me/Development/fleet-control-service</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/Users/me/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>FLEET_CONF</key><string>/Users/me/.local/share/fleet-control/test-fleet/fleet.conf</string>
    <key>READONLY_FLEET_BIN</key><string>/Users/me/Development/agent-fleet-dev/scripts/fleet</string>
    <key>FLEET_CONTROL_DB</key><string>/Users/me/Library/Application Support/fleet-control/state.db</string>
    <key>FLEET_CONTROL_HOST</key><string>127.0.0.1</string>
    <key>FLEET_CONTROL_TOKENS</key><string>/Users/me/.config/fleet-control/tokens</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/Users/me/Library/Logs/fleet-control.log</string>
  <key>StandardErrorPath</key><string>/Users/me/Library/Logs/fleet-control.log</string>
</dict></plist>
```

Owner decisions (2026-11-09): no listener on Tailscale (superseded 2026-11-19: the MacBook panel reaches each host on its Tailscale IP through the optional second listener, `FLEET_CONTROL_TAILNET_*` above); the route is the LAN with TLS and tokens. For the real install set `FLEET_CONTROL_HOST` to `192.168.50.4` and add `FLEET_CONTROL_TLS_CERT` / `FLEET_CONTROL_TLS_KEY`. Not installed. Homebrew tmux and bash are in `/opt/homebrew/bin`, which launchd does not put on PATH by default.

Install steps (need the owner's approval): copy a checkout to the working directory, `bun install --frozen-lockfile`, create the tokens file (`chmod 600`), `launchctl bootstrap gui/$(id -u) <plist>`, then `curl -s -o /dev/null -w '%{http_code}' http://<bind address>:4871/api/sessions` must print 401 (or 200 on loopback without tokens).
