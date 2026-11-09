# One MacBook, independent hosts

The host service remains responsible for execution and durable state. Run one service on the Linux workstation and another on the Mac. The MacBook client gateway serves a single Terminal Deck and forwards explicitly selected host operations. It has no fleet database, scheduler or SSH/tmux adapter.

Closing the gateway detaches terminal viewers. It does not cancel delivered work, retry uncertain commands or resolve pending approvals.

## Prepare each host

Follow [the host installation guide](install-guide.md) for TLS, a persistent SQLite path and a separate client principal. Start with isolated shell-only fleets. Do not point the page at production agents until the agent-fleet read-only viewer/send compatibility gate passes.

Use a unique token for the MacBook on each host. Store the plaintext tokens on the MacBook in separate files outside the repository, with directory mode 700 and file mode 600. The host keeps only token hashes. Never copy a CA private key onto a host.

Remote services must use HTTPS with a certificate the gateway runtime trusts. For a private mkcert CA, start Bun with `NODE_EXTRA_CA_CERTS` pointing to the public root certificate. This is additive trust, not disabled certificate checking. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Configure the MacBook

Example configuration, not a deployed host list:

```json
{
  "hosts": [
    {
      "id": "linux",
      "name": "Linux workstation",
      "url": "https://linux-workstation.example:4871",
      "tokenFile": "./token-linux"
    },
    {
      "id": "mac",
      "name": "Mac workstation",
      "url": "https://mac-workstation.example:4871",
      "tokenFile": "./token-mac"
    }
  ]
}
```

Replace the example origins with your configured services. IDs are stable routing keys, not labels or session names. Token paths are resolved relative to the configuration file. Do not put plaintext tokens in JSON or commit this configuration with credentials.

```bash
FLEET_CONTROL_CLIENT_CONFIG="$HOME/.config/fleet-control/client.json" \
  NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" \
  bun run client
```

Open `http://127.0.0.1:4870/`. The client only binds loopback. `PORT` changes its port. It does not need `FLEET_CONF`, tmux, host runtime credentials or a local supervisor. Stop it with Ctrl+C. Anyone with access to this local service as an authorized local user can operate the configured hosts; loopback is not protection against hostile local processes.

## Navigation and decisions

- Select a host to view its terminal panes and supervisor panel. Select a nested session to emphasize its pane.
- Equal session and run names on different hosts remain separate. A command's target includes the selected host; a request answer includes that host's request and revision.
- An unavailable host means its current state is unknown. It does not mean its sessions stopped. Other hosts remain usable.
- A write with an uncertain response is not automatically retried. Retry the unchanged command intent with its idempotency key; do not reinterpret it as completed.
- Host tokens stay in the gateway process. They are not returned to the browser or forwarded from one host to another.

## Local assistant through MCP

Keep a separately named MCP connection for each host, using that host's token and TLS origin:

```bash
claude mcp add --scope user --transport http fleet-linux \
  https://linux-workstation.example:4871/mcp --header "Authorization: Bearer <linux-client-token>"
claude mcp add --scope user --transport http fleet-mac \
  https://mac-workstation.example:4871/mcp --header "Authorization: Bearer <mac-client-token>"
```

Use a credential-safe configuration method rather than saving actual tokens in shell history. A tool call to one host cannot approve a request on another. The gateway is for the browser, not a replacement durable MCP control plane.

## Linux service example

This is an operator-reviewed template, not a claim of installation. Bun, bash 4+, tmux and the approved agent-fleet CLI must already exist. Run as the same non-root user as the fleet. Use absolute paths, replacing `/home/fleet` and the LAN address with the host's values.

```ini
# ~/.config/systemd/user/fleet-control.service
[Unit]
Description=Fleet Control host service
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/fleet/Development/fleet-control-service
Environment=PATH=/home/fleet/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=FLEET_CONF=/home/fleet/.local/share/fleet-control/test-fleet/fleet.conf
Environment=READONLY_FLEET_BIN=/home/fleet/Development/fleet-control-service/vendor/agent-fleet/scripts/fleet
Environment=FLEET_CONTROL_DB=/home/fleet/.local/share/fleet-control/state.db
Environment=FLEET_CONTROL_HOST=192.0.2.10
Environment=FLEET_CONTROL_TOKENS=/home/fleet/.config/fleet-control/tokens
Environment=FLEET_CONTROL_TLS_CERT=/home/fleet/.config/fleet-control/cert.pem
Environment=FLEET_CONTROL_TLS_KEY=/home/fleet/.config/fleet-control/key.pem
UnsetEnvironment=NO_COLOR
ExecStart=/home/fleet/.bun/bin/bun index.ts
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
```

Create the state directory before starting, then validate with `systemd-analyze --user verify`, reload and start the user unit. Enabling it at login and enabling user lingering for logout/reboot survival are separate operator decisions. Starting this unit does not start a fleet or supervisor. macOS uses the launchd instructions in [installation](installation.md).

## Proof boundary

Two local host services can prove routing, identity isolation, terminal relay and failure handling. They do not prove operation on Linux, host reboot recovery or production-agent compatibility. Deployment to 192.168.50.15 remains on hold. No Tailscale listener is required or enabled by this design.
