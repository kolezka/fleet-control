# Fleet Control session handoff

Prepared 2026-11-09. Project: `/Users/me/Development/fleet-control`. This is a separate project from ai-docify, where the originating conversation happened to start.

## Start here

1. Read this file and [docs index](README.md).
2. Open [the selected design](design/terminal-deck.html). It is self-contained and does not depend on a running preview server.
3. Read [architecture](architecture.md), [control protocol](control-protocol.md) and [installation split](installation.md).
4. Read [UI design](ui-design.md), the [visual tokens](../.design/design-system.md) and [model visibility requirement](model-observability.md).
5. Check [implementation status](implementation-status.md) before claiming anything works outside the mockup.

Do not restart product discovery or redesign the agreed layout without a new reason. The next useful work is an approved technical implementation plan and a small integration probe, not another unrelated visual direction.

## Selected design baseline

Stable entry: `docs/design/terminal-deck.html`.

It is an exact copy of `.design/drafts/console/terminal-deck/v4.html`, not a new implementation. The user selected Terminal Deck and then requested the changes embodied in v2-v4. This is the latest handoff baseline; it does not mean every interaction has received final product acceptance.

Visual references:

- [Desktop dark](design/desktop-dark.png)
- [Desktop light](design/desktop-light.png)
- [Phone dark](design/phone-dark.png)
- [Phone light](design/phone-light.png)

The phone screenshots contain a real 390px layout inside the rendering tool's 500px frame; the grey strip on the right is not application chrome.

[manifest.json](design/manifest.json) records source files and SHA-256 hashes. Copies were compared with their sources, and PNG signatures/dimensions were checked. These are same-machine design snapshots, not backups.

Preserve historical drafts. When the selected design changes, update the baseline, manifest and documentation together; do not let the stable snapshot and selected draft diverge silently.

## Decisions to preserve

- Remote supervisor: execution and durable state belong on the workstation. MacBook is a client and can go offline.
- Reuse agent-fleet CLI for existing session operations. Extend phased-delivery where structured state and decisions are needed.
- Browser terminals should use a Ghostty-based renderer, but no renderer or PTY transport is connected yet.
- Full-window UI with no outer frame, margin or rounded application shell.
- Only one host/session navigation, on the left. Hosts have distinct headers and nested session rows.
- Selecting a host shows all its available session views; selecting a child changes emphasis without dropping its siblings.
- Right sidebar for requests, workflow, evidence and command/response history. The bottom tray was explicitly rejected.
- No permanent top-level Text/State selects. Small view options live in an overflow menu.
- Use Apple HIG through Docify, registered as `apple-his@1.0.0`, and the selected tokens. Do not substitute an unrelated dashboard style.
- Queued, delivered, accepted and completed are separate facts. An approval is scoped to a phase revision and does not imply the next phase started.
- The local assistant relays user authority; it is not a second supervisor that can approve its own sensitive requests.

## Latest request not yet in the design

The user also requested the model currently used by each session. This is documented in [model-observability.md](model-observability.md), but no model label or telemetry is present in v4.

Planned presentation: a compact label beside the session name, with details for full identity, observation source and time. Distinguish observed, configured-only, unknown/stale and not-applicable. Never present a configured default as a verified runtime observation. A shell watchdog is not an LLM session.

## What actually exists

- A Bun-initialized project with documentation and static interactive designs.
- `index.ts` starts a local read-only service over the fleet CLI (stages 1-2 below). It is not connected to any workstation.
- v4 includes synthetic terminal output, in-memory requests, demo approvals and a command composer.
- `bun run design:check` checks the preserved design's handlers with a minimal DOM fixture.

No real workstation service, remote MCP server, persistent queue, model collector, terminal bridge, authentication flow or deployment was built. The apparent worker/reviewer terminals are illustrative: the inspected phased-delivery implementation uses Agent subagents, not guaranteed standalone tmux sessions.

## Verification at handoff

- Design HTML and four PNGs copied without changing their bytes; SHA-256 equality confirmed.
- PNG dimensions checked: desktop 1440x900; phone screenshot frames 500x844 containing the 390px layout.
- `bun run design:check`: exit 0 against the preserved design. Checks include blank input, escaped command text, queued-only receipt, approval awaiting acknowledgement, no automatic next-phase start, decline and disconnected refusal.
- Earlier design-studio renders were inspected in light/dark desktop and phone layouts. This handoff reuses those saved renders; it is not a new visual revision.

The handler check is not browser automation. No production build, live fleet test, reconnect/restart test or accessibility audit has passed because those integrations do not exist here. Do not upgrade these results into production verification.

## Session 2 update (2026-11-09)

- Plan stages 1-6 proposed; user asked to proceed as a goal. Stages 1-2 done locally on branch `feat-fleet-adapter` (worktree `.agents/worktrees/feat-fleet-adapter`). Details and verification: [implementation status](implementation-status.md). Not merged into main.
- Target hosts named by the user: `192.168.50.15` (SSH as root, port 27022) and `192.168.50.4`. Access from the MacBook over LAN and Tailscale. Not contacted yet.
- User decisions (2026-11-09, asked one at a time): both hosts are **peers, each with its own Fleet Control service** (two independent fleets grouped in the left nav, no shared scheduler). SSH: `.15` as `root` port 27022, `.4` as `me` port 22. Execution user on both: `me` (`.15` via `REMOTE_USER=me`).
- Read-only reconnaissance (approved, one SSH call per host, 2026-11-09):

| | 192.168.50.15 | 192.168.50.4 |
| --- | --- | --- |
| Hostname | me-desktop | Mac-mini-Mariusz.local |
| OS | Manjaro Linux, kernel 6.12, x86_64 | macOS (Darwin 27.2), arm64 |
| Tailscale IPv4 | 100.64.0.5 | 100.64.0.6 |
| User `me` | uid 1000, groups incl. wheel, docker | uid 501, admin |
| tmux | 3.7c | 3.8 (Homebrew, installed 2026-11-09 with approval) |
| bash | 5.3 | 5.3 in /opt/homebrew/bin (installed 2026-11-09); /bin/bash 3.2 and login shell /bin/zsh unchanged |
| bun / claude / git / rg | 1.4.0 / 2.1.319 / 2.55 / 15.2 | 1.4.4 / 2.1.311 / 2.54 / 15.2 |
| agent-fleet plugin | 0.3.0, installed 2026-11-09 with user approval (`claude plugin install agent-fleet@kolezka --scope user` as me); `scripts/fleet` and `watchdog.sh` SHA-256 identical to the MacBook copy | 0.3.0 |
| Disk free (home fs) | **64G free, 93% used** | 134G free |
| Live tmux | production sessions `tv-*` incl. `tv-watchdog` on the default socket, plus leftover `fleet-fleetsmoke*` sockets | none (tmux was missing at recon) |

  Consequences: on `.4` the fleet CLI (`#!/usr/bin/env bash`) needs `/opt/homebrew/bin` first in PATH, which a non-login SSH command or launchd job does not get by default; the service must set PATH explicitly. `.15` runs a production fleet (`tv-*`); never attach to, send to or kill those sessions; tests use their own private socket. Low disk on `.15` is a risk for worktrees.
- User then said: do not touch `192.168.50.15` for now. No further contact with either host after the installs above.
- Approved: `ghostty-web` 0.4.0 pinned in this worktree; a local agent-fleet worktree adding `fleet attach --read-only` (no push).
- Stage 3 (read-only terminal) done locally on the MacBook against a private test fleet: see [implementation status](implementation-status.md). The agent-fleet change lives on branch `feat/attach-read-only` in `~/Development/agent-fleet.worktrees/attach-read-only` was merged as kolezka/agent-fleet#6 (`8a1bd2c`). The plugin version was not bumped (still 0.3.0), so installed plugin caches lack it and Fleet Control still needs `READONLY_FLEET_BIN` pointing at a checkout of agent-fleet `main` until a version bump ships.
- User chose option 2: no agent-fleet version bump for now, stage 4 locally.
- Stage 4 (durable command queue, `fleet send` delivery, MCP at `/mcp` and REST at `/api/commands`) done locally: see [implementation status](implementation-status.md). Then, with paid-agent approval, one Haiku test supervisor with only the MCP tools accepted, completed and rejected commands; evidence from the database in `docs/evidence-2026-11-09-supervisor-ack.txt`, cost $0.0029. Found: `NO_COLOR=1` makes agent-fleet mistake the prompt suggestion for typing (fleet send exit 4).
- Remaining stages: 5 scoped requests/approvals, 6 workstation deployment with auth on LAN/Tailscale only.

## Next action

Options: (a) report the `NO_COLOR` typing-detection gap to agent-fleet; (b) stage 5, scoped requests and approvals, locally; (c) connect the page composer to `/api/commands`. An agent-fleet version bump is still pending before deployment. Workstation work waits for the user to lift the `.15` hold. `runner-01` is only a design fixture, not an authorized connection target.

Then propose a bounded implementation plan. Recommended first technical milestone: attach to an isolated test session through the existing fleet CLI, read meaningful output, detach without terminating the session, and verify reconnect behavior. Do not use a valuable live agent session as the experiment.

Before code implementation, recheck Git state and create an isolated worktree. The original design pass began without a Git repository; the user subsequently authorized local initialization and an initial snapshot on `main`. Inspect the actual branch and log rather than relying on earlier no-repository notes. No remote creation or push is authorized.

Remaining choices include auth/network setup, host service packaging, durable machine-readable phase records, supervisor acknowledgement, input leases, subagent view mapping and runtime model metadata. Exact production API/MCP names are proposals, not implemented interfaces.

## Authorization boundary

The user approved the design direction, remote-supervisor architecture, local documentation and a handoff package. They did not authorize workstation access, real shell exposure, credential changes, production installation, deployment, spending, push or merge by approving these designs.

No secrets belong in project docs. Do not retry the denied Hindsight write without approval. The attempted external initiative capture was blocked; the authoritative handoff is local. Outline previously resolved this folder to a generic workspace project, so no new Outline task record was written under an assumed identity.

## Preview and tool caveats

From the project root:

```bash
open docs/design/terminal-deck.html
bun run design:check
```

`open` is the macOS viewer command. On another system, open the HTML with a browser. No web server is needed for the baseline.

A local design-studio canvas was started at `http://127.0.0.1:4870/` in the originating session. Its continued availability is not part of this handoff. Do not assume that a process currently occupying that port belongs to this project, and do not kill it without checking ownership. The files remain usable if the canvas stops.

Design-studio scripts came from the installed plugin, not from this project's runtime. Discover the installed skill path in a new environment rather than assuming the old plugin cache exists. The `.design/` generator scripts retain historical paths and refuse to overwrite their versions; do not rerun them as a project setup command.
