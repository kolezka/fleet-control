# MacBook and workstation installation

Status: target installation split. This is an inventory, not an executable setup guide. Fleet Control's server and installers have not been implemented, and the actual workstation OS, address and access method are not selected here.

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
