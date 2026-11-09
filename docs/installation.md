# MacBook and workstation installation

Status: target installation split plus the service configuration that exists in the feat-fleet-adapter worktree (section "Running the service"). Chosen hosts: 192.168.50.4 (macOS, user `me`) and 192.168.50.15 (Manjaro, user `me`, on hold). Nothing has been installed as a persistent service yet.

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

## First-run and recovery gates

Before live use:

1. Identify the host, execution user and managed repositories.
2. Install pinned tools and establish independent host authentication.
3. Have the owner complete workspace trust where the agent CLI requires it. Fleet automation must not answer that prompt on their behalf.
4. Configure allowed actions, budgets, stop time and escalation boundaries.
5. Verify a read-only session attachment before granting input control.
6. Test MacBook disconnect/reconnect, then supervisor replacement and workstation restart as separate scenarios.

Autostart, watchdog behavior and restart policy must be reviewed before enabling them. Do not automatically resume ambiguous in-flight commands after a restart. Reconcile command and runtime identities first.

A copied database is not a verified backup. Backup location, validation and restore testing remain deployment decisions.

## Running the service

Environment for `bun index.ts`:

| Variable | Meaning |
| --- | --- |
| `FLEET_CONF` | Required. The agent-fleet `fleet.conf` of the fleet on this host. |
| `READONLY_FLEET_BIN` | fleet CLI with `attach --read-only` (agent-fleet main after PR #6). Default: plugin cache, which lacks it until a release. |
| `FLEET_CONTROL_DB` | SQLite file. Default `:memory:`, which loses commands and requests on restart. |
| `PORT` | Default 4871. |
| `FLEET_CONTROL_HOST` | Bind address. Default `127.0.0.1`. Any other value requires `FLEET_CONTROL_TOKENS`; the service refuses to start without it. |
| `FLEET_CONTROL_TOKENS` | Tokens file: `<principal> <sha256 hex>` per line. Only hashes live on the host. |
| `FLEET_CONTROL_ALLOWED_HOSTS` | Extra `host:port` values accepted on `/mcp` (DNS rebinding protection), e.g. a Tailscale name. The bind address is added automatically. |
| `FLEET_CONTROL_TLS_CERT`, `FLEET_CONTROL_TLS_KEY` | Optional PEM files. Without them traffic is plain HTTP, so tokens cross the network in clear text. Use Tailscale (encrypted) or add TLS before using LAN. |

Clear `NO_COLOR` in the service environment: agent-fleet misreads Claude Code's input line when it is set (docs/bugs/agent-fleet-no-color-user-typing.md).

Tokens: `bun scripts/new-token.ts <principal>` prints a token once and the line for the tokens file. One principal per client, e.g. `macbook-session`, `web-mariusz`, `orchestrator`. The principal is recorded as the actor of every command, answer and phase write, and replaces any actor name a client sends. Revoke by deleting the line and restarting the service.

Clients:

- Browser: open `http://<host>:4871/login`, paste a token. It is stored in an HttpOnly, SameSite=Strict cookie (Secure with TLS), so page scripts cannot read it.
- MCP from the MacBook (Claude Code): `claude mcp add --transport http fleet-control-mini http://<host>:4871/mcp --header "Authorization: Bearer <token>"`. Keep the token out of shared config files.

## launchd on 192.168.50.4 (draft, not installed)

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
    <key>FLEET_CONF</key><string>/Users/me/.config/fleet-control/fleet.conf</string>
    <key>READONLY_FLEET_BIN</key><string>/Users/me/Development/agent-fleet-dev/scripts/fleet</string>
    <key>FLEET_CONTROL_DB</key><string>/Users/me/Library/Application Support/fleet-control/state.db</string>
    <key>FLEET_CONTROL_HOST</key><string>100.64.0.6</string>
    <key>FLEET_CONTROL_TOKENS</key><string>/Users/me/.config/fleet-control/tokens</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/Users/me/Library/Logs/fleet-control.log</string>
  <key>StandardErrorPath</key><string>/Users/me/Library/Logs/fleet-control.log</string>
</dict></plist>
```

`100.64.0.6` binds Tailscale only. Binding the LAN address as well needs a second instance or `0.0.0.0` plus a firewall rule; decide that with the owner. Homebrew tmux and bash are in `/opt/homebrew/bin`, which launchd does not put on PATH by default.

Install steps (need the owner's approval): copy a checkout to the working directory, `bun install --frozen-lockfile`, create the tokens file (`chmod 600`), `launchctl bootstrap gui/$(id -u) <plist>`, then `curl -s -o /dev/null -w '%{http_code}' http://100.64.0.6:4871/api/sessions` must print 401.
