# Fleet Control

Fleet Control is a terminal-first interface for supervising remote agent work. The supervisor, execution and durable run state belong on a workstation. The MacBook is a client and does not need to stay online for already-authorized work to continue.

This directory records the design discussion and decisions as of 2026-11-09. It is not a claim that the runtime is implemented or deployed.

## Read in this order

For a new coding session, use the [metaprompt](NEXT_SESSION_PROMPT.md), then read [HANDOFF.md](HANDOFF.md) and the [preserved design](design/terminal-deck.html).

1. [Architecture](architecture.md): roles, host ownership and existing plugin integration.
2. [Installation split](installation.md): what belongs on the MacBook and workstation.
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

The project was initialized with Bun. The entry point still prints `Hello via Bun!`; it is not a server. The selected interactive design is [Terminal Deck v4](../.design/drafts/console/terminal-deck/v4.html). It uses synthetic sessions and in-memory state.

The workstation service, remote MCP endpoint, durable queue, live terminal bridge and model telemetry are not implemented in this prototype. No workstation has been configured by this work.

Architecture approval does not authorize live shell access, dependency installation, credential changes, deployment, push or merge. This documentation task only records the agreed direction and proposals.

## Documents and drafts

`docs/` is the consolidated project documentation. `.design/` retains versioned mockups, visual tokens, rendering evidence and design working notes. Older drafts intentionally preserve superseded layouts, such as the bottom tray and local supervisor. Use the latest selected draft and these documents for current intent.

The request to save these documents is local. No external publication or memory write is part of this save.
