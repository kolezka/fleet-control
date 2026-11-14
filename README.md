# Fleet Control

A web page and backend services for watching and steering a fleet of agents that run in tmux.

## Current backend deployment

As of 2026-11-13, [PR #58](https://github.com/kolezka/fleet-control/pull/58) and [PR #59](https://github.com/kolezka/fleet-control/pull/59) are merged. The deployment evidence is in [the two-host rollout record](docs/deploy-15-plan.md#deployment-2026-11-13).

- The persistent cooperative central service and PostgreSQL 17 run on `.15` with Docker Compose. PostgreSQL has no published port; the central application listens on host loopback.
- Central is reachable only inside the private tailnet at [https://local-arch.tail4a51cb.ts.net:4881](https://local-arch.tail4a51cb.ts.net:4881). Tailscale Serve terminates HTTPS and forwards to loopback; this is not a public endpoint or a web UI.
- Persistent cooperative adapters run on `.15` (Compose) and `.4` (launchd), each listening on `127.0.0.1:4882` with its own supervisor identity and incarnation. Supervisors claim work and report through MCP; there is no tmux paste fallback or idle-agent wakeup.
- Synthetic submit, claim, accepted/running/completed reports and operator inspection passed through both adapters, then passed again after central and both adapters restarted. Incarnations stayed unchanged. No real agents or production fleet sessions were used for those checks.
- The deployed legacy `.4` host service and UI remain unchanged. An opt-in local gateway now connects the Terminal Deck command panel to cooperative central; that integration has not been deployed. See [cooperative client configuration](docs/multi-host.md#optional-cooperative-central-commands).
- A lead-verified real DSH run on `.15` completed through the persistent desktop adapter and tailnet central in about 13 seconds: accepted/running/completed, exact fixture answer `2: host-b, host-d`, unchanged file and no token leak. This was read-only scratch work, not a UI, idle-wakeup or production-session test; see [the run evidence](docs/central-server-status.md#real-dsh-on-15-2026-11-13).

See [cooperative deployment](deploy/cooperative/README.md), [persistent adapter setup](deploy/cooperative/README.md#persistent-adapters-and-tailnet-access), [central backend status](docs/central-server-status.md) and [session handoff](docs/HANDOFF.md). The host-service instructions below describe the separate SQLite-backed UI path, not the cooperative deployment.

## What is what

There are two repositories. This one calls the other.

| | [agent-fleet](https://github.com/kolezka/agent-fleet) | fleet-control (this repo) |
| --- | --- | --- |
| What it is | A Claude Code plugin with the `fleet` command and a watchdog | A service with a web page, an API and MCP |
| What it does | Starts agents in tmux, pastes messages into them, reads their screens, answers dialogs, nudges stuck agents | Shows the agents' terminals (read-only), the model each one uses, supervisor requests, approvals and commands, and keeps all of that in a database |
| How it talks to tmux | Directly | Runtime terminal access uses the `fleet` command. The separate installation CLI can invoke a prepared remote installer through SSH |
| State | Files in the fleet directory | PostgreSQL for cooperative control; SQLite for the separate host service |

In short: agent-fleet runs the agents; Fleet Control is the control panel on top of it.

## How the separate host UI fits together

```
 MacBook (client, may go offline)            Host, e.g. 192.168.50.4 (does the work)
 ┌────────────────────────────┐              ┌──────────────────────────────────────┐
 │ Browser  ── page, API ─────┼──── HTTPS ──►│ Fleet Control service (bun index.ts) │
 │ Claude Code ── MCP ────────┼──── HTTPS ──►│   SQLite: commands, requests, phases │
 └────────────────────────────┘              │   calls: fleet status / screen /     │
                                             │          send / attach --read-only   │
                                             │                 │                    │
                                             │   tmux sessions with agents          │
                                             └──────────────────────────────────────┘
```

- The service runs on the host where the agents run. It keeps working when the MacBook is closed.
- A command goes through separate states: queued, delivered (pasted into the agent), accepted or rejected by the agent, then completed or failed. "Delivered" does not mean the agent did it.
- An approval belongs to one request, one phase and one revision. No answer, or a disconnected MacBook, is never an approval.
- The page's terminals are read-only. The page cannot type into an agent; it sends instructions as commands.

## What you need

- [Bun](https://bun.sh) 1.4 or newer.
- tmux 3.x and bash 4+ (on macOS: `brew install tmux bash`).
- The pinned agent-fleet submodule at `vendor/agent-fleet` (includes read-only attach and the viewer/send fix). No separate checkout is required.

## Install

For fresh cooperative central, adapter or client installations from a prepared checkout, use the [installation CLI](docs/install-cli.md). It prints a plan before any explicit apply and can invoke the same CLI through SSH. It does not upgrade existing installations or install prerequisites.

To install the separate legacy host service on a host so it runs in the background and is reachable from the MacBook, follow **[docs/install-guide.md](docs/install-guide.md)** step by step. The short version for trying it locally:

```bash
git clone --recurse-submodules git@github.com:kolezka/fleet-control.git
cd fleet-control
bun install
```

Existing checkout: `git submodule update --init --recursive`. After `git pull`, run that command again to use the recorded dependency commit. Do not use `--remote` for routine installs. See [dependency maintenance](docs/agent-fleet-dependency.md).

## Run it

### 1. Try it safely with a test fleet

This starts a private tmux server with one harmless session (`probe-shell`, no agent) and the service on your own machine.

```bash
env -u NO_COLOR \
  PORT=4881 \
  bun scripts/dev-test-fleet.ts
```

Open http://127.0.0.1:4881/. Stop with Ctrl+C; it removes the test session too. No login is needed because it listens only on your own machine.

### 2. Run it for your own fleet

```bash
env -u NO_COLOR \
  FLEET_CONF=/path/to/your/fleet.conf \
  FLEET_CONTROL_DB=~/fleet-control-state.db \
  bun run serve
```

Open http://127.0.0.1:4871/. Stop with Ctrl+C. Commands, requests and approvals are kept in the database file and survive a restart. Without `FLEET_CONTROL_DB` they are lost when it stops.

`FLEET_CONF` is the agent-fleet `fleet.conf`, and it must sit in the fleet directory (`FLEET_DIR`), because agent-fleet reads it from there.

### 3. Make it reachable from another machine

Anything other than `127.0.0.1` needs tokens; the service refuses to start without them. Use TLS on a LAN, otherwise tokens travel in clear text.

1. Create one token per client. The command prints the token once (keep it, the host never stores it) and adds its hash to `./tokens`:

   ```bash
   bun scripts/new-token.ts web-mariusz ./tokens
   bun scripts/new-token.ts macbook-session ./tokens
   ```

   To revoke a client, delete its line from `./tokens` and restart the service.

2. Get a certificate for the host's address, for example with [mkcert](https://github.com/FiloSottile/mkcert) on the MacBook: `mkcert 192.168.50.4`.

3. Start the service:

   ```bash
   env -u NO_COLOR \
     FLEET_CONF=/path/to/fleet.conf \
     FLEET_CONTROL_DB=~/fleet-control-state.db \
     FLEET_CONTROL_HOST=192.168.50.4 \
     FLEET_CONTROL_TOKENS=./tokens \
     FLEET_CONTROL_TLS_CERT=./192.168.50.4.pem \
     FLEET_CONTROL_TLS_KEY=./192.168.50.4-key.pem \
     bun run serve
   ```

4. Browser: open `https://192.168.50.4:4871/`, paste your token. You stay signed in for 30 days.

5. Claude Code on the MacBook (MCP):

   ```bash
   claude mcp add --scope user --transport http fleet-control-mini \
     https://192.168.50.4:4871/mcp --header "Authorization: Bearer <token>"
   claude mcp list    # should say: Connected
   ```

   The token's name is recorded as the author of everything that client does. A client cannot pretend to be someone else.

To keep it running in the background on macOS, see the launchd section in [docs/installation.md](docs/installation.md), including how to stop and remove it.

## Two hosts from one MacBook

Run one independent host service on Linux and another on macOS. Use the MacBook's loopback client gateway for a single host-grouped Terminal Deck; each workstation keeps its own supervisor and SQLite state.

```bash
FLEET_CONTROL_CLIENT_CONFIG="$HOME/.config/fleet-control/client.json" bun run client
```

See [multi-host setup](docs/multi-host.md) for the host list, separate token files, TLS trust and per-host MCP connections. The gateway does not run agents, merge queues or retry uncertain writes. To try two independent local shell-only services without connecting to any workstation:

```bash
env -u NO_COLOR bun run demo:two-hosts
```

Run the client command printed by the demo in another terminal. Both hosts are local fixtures, not proof of Linux/macOS deployment.

## Settings

| Variable | Meaning | Default |
| --- | --- | --- |
| `FLEET_CONF` | agent-fleet `fleet.conf` of the fleet to watch | required for `serve` |
| `READONLY_FLEET_BIN` | Explicit CLI override (takes precedence over `FLEET_BIN`) | `vendor/agent-fleet/scripts/fleet` |
| `FLEET_CONTROL_DB` | SQLite file | in memory, lost on stop |
| `PORT` | Port | 4871 |
| `FLEET_CONTROL_HOST` | Address to listen on | `127.0.0.1` |
| `FLEET_CONTROL_TOKENS` | Tokens file (hashes only) | none; required for any non-loopback address |
| `FLEET_CONTROL_TLS_CERT`, `FLEET_CONTROL_TLS_KEY` | Certificate and key (PEM) | plain HTTP |
| `FLEET_CONTROL_HOST_NAME` | Host name shown in the page | machine name |
| `FLEET_CONTROL_PEERS` | Other hosts' services shown as links, `name=https://host:4871,...` | none |
| `FLEET_CONTROL_ALLOWED_HOSTS` | Extra `host:port` names accepted on `/mcp` | bind address |

Always clear `NO_COLOR` (`env -u NO_COLOR`). With it set, agent-fleet mistakes Claude Code's grey suggestion for someone typing and refuses to send.

## Using the page

- **Left:** hosts and their sessions. Each session shows whether it runs and which model it uses: *observed* (read from the agent's own transcript), *configured* (set, not seen), *unknown* (with the reason) or *no model* for scripts.
- **Centre:** the live terminal of the selected session, read-only. It reconnects by itself after a dropped connection.
- **Right:** the supervisor panel. Open requests with Approve or Decline, the run's phase, recent commands with their honest state, and a field to send an instruction to the supervisor.
- Below 900 px the right panel opens over the terminal with the panel button; Escape closes it.

## Checks

```bash
env -u NO_COLOR bun test   # unit and real-tmux tests
bun check                                                                            # types
bun run design:check                                                                 # the original design mockup's handlers
```

The tests start their own private tmux servers and never touch your sessions.

## Known limits

- The pinned agent-fleet includes the viewer/send fix; the real-shell regression passes. Overrides pointing to older checkouts may still have that bug. This is not production-agent verification.
- Model detection works for Claude Code only, on the same host as the service.
- phased-delivery does not yet write its phase record through MCP. Typing into a terminal (input leases) does not exist.
- The cooperative backend is deployed on `.15` and `.4`, but is not connected to the UI. One read-only real DSH fixture task on `.15` passed; production sessions and idle-agent wakeup remain unverified.

## More

- [docs/HANDOFF.md](docs/HANDOFF.md): where the project stands and what is next. Start here in a new coding session.
- [docs/implementation-status.md](docs/implementation-status.md): what is built, what was verified and what is still open.
- [docs/install-guide.md](docs/install-guide.md): step-by-step install on a host.
- [docs/installation.md](docs/installation.md): running the service, the install on 192.168.50.4, launchd, removal.
- [docs/architecture.md](docs/architecture.md), [docs/control-protocol.md](docs/control-protocol.md), [docs/model-observability.md](docs/model-observability.md): design of the parts.
- [docs/design/terminal-deck.html](docs/design/terminal-deck.html): the original interactive mockup the page is built from (static, not connected).
