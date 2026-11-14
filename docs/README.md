# Fleet Control

Fleet Control is a terminal-first interface for supervising remote agent work. The supervisor, execution and durable run state belong on a workstation. The MacBook is a client and does not need to stay online for already-authorized work to continue.

This directory records the design discussion and decisions as of 2026-11-09. It is not a claim that the runtime is implemented or deployed.

## Read in this order

For a new coding session, use the [metaprompt](NEXT_SESSION_PROMPT.md), then read [HANDOFF.md](HANDOFF.md) and the [preserved design](design/terminal-deck.html).

1. [Architecture](architecture.md): roles, host ownership and existing plugin integration.
2. [Installation split](installation.md): what belongs on the MacBook and workstation.
- [install-guide.md](install-guide.md): step-by-step legacy host-service install (launchd, TLS, tokens, clients).
- [Installation CLI](install-cli.md): fresh central, adapter and client setup from prepared local or SSH checkouts.
3. [Control protocol](control-protocol.md): commands, requests, decisions, events and terminal access.
4. [Interface design](ui-design.md): selected Terminal Deck layout and Apple HIG sources.
5. [Session model visibility](model-observability.md): observed versus configured models and freshness.
6. [Implementation status](implementation-status.md): current files, checks, gaps and open decisions.

## Status vocabulary

- **Agreed:** explicitly selected or requested by the user.
- **Proposed:** a suggested implementation, not a settled API or deployed capability.
- **Implemented in the mockup:** a local, synthetic HTML interaction only.
- **Open:** needs a design decision or a real integration check.

## Agreed direction

- Use a web console with embedded session terminals; explore Ghostty-based browser rendering.
- Reuse agent-fleet CLI behavior rather than build a second tmux/SSH controller.
- Use phased-delivery for phased execution, verification, review and human decisions.
- Run the supervisor on the workstation. The MacBook communicates with it as a client.
- Keep host/session navigation on the left, without duplicate top session tabs.
- Use the selected Terminal Deck design and Apple Human Interface Guidelines retrieved through Docify.
- Fill the window, with no outer frame, margin or rounded application shell.
- Put supervisor requests, workflow, evidence and command history in a right sidebar.
- Show the model used by each agent session, distinguishing runtime observations from configuration.

## Current state

`index.ts` starts the Bun host service over the existing fleet CLI: read-only terminals, persistent SQLite when configured, commands, scoped requests, MCP, token authentication, optional TLS and Claude Code model observations. A test-fleet service was installed on the macOS host 192.168.50.4 with authorization; see [implementation status](implementation-status.md) for evidence and limits. The separate cooperative central and PostgreSQL now run on `.15`, with persistent loopback adapters on `.4` and `.15` and tailnet HTTPS via Tailscale Serve. An isolated read-only DSH task on `.15` passed through CLIProxyAPI and the deployed cooperative path. These are not upgrades of the legacy `.4` host service or a connection of the Terminal Deck to the central API. See [current handoff](HANDOFF.md#latest-central-server-and-cooperative-supervisor-in-progress) and [bounded run evidence](central-server-status.md#real-dsh-on-15-2026-11-13).

The [decentralized-client plan](decentralized-client-plan.md) adds one MacBook view over independent host services. [Multi-host setup](multi-host.md) describes the local gateway, host credentials, per-host MCP and Linux service template. Check the current handoff for verification status before deploying.

The preserved [Terminal Deck v4](../.design/drafts/console/terminal-deck/v4.html) is still a synthetic historical design, separate from the live page. Writable terminal input and phased-delivery integration remain unimplemented.

Architecture approval does not authorize live shell access, dependency installation, credential changes, deployment, push or merge. This documentation task only records the agreed direction and proposals.

## Documents and drafts

`docs/` is the consolidated project documentation. `.design/` retains versioned mockups, visual tokens, rendering evidence and design working notes. Older drafts intentionally preserve superseded layouts, such as the bottom tray and local supervisor. Use the latest selected draft and these documents for current intent.

The request to save these documents is local. No external publication or memory write is part of this save.
