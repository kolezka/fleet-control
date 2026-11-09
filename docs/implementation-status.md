# Implementation status and next decisions

Recorded 2026-11-09. This is a source-scoped status report for the local Fleet Control prototype, not an inventory of unrelated services on the machine.

## Existing project files

| File | Current purpose |
| --- | --- |
| `package.json` | Private Bun project; typecheck script; Bun types and TypeScript declarations |
| `index.ts` | Starts the read-only loopback service; requires `FLEET_CONF` |
| `src/fleet/cli.ts` | Adapter over agent-fleet `fleet screen` and `fleet status`, with explicit error kinds |
| `src/fleet/fixture.ts` | Isolated test fleet: private tmux socket, temp FLEET_DIR, one shell session with no model |
| `src/server.ts`, `src/store.ts`, `src/model.ts` | Loopback HTTP API, bun:sqlite session registry, model-state rules |
| `src/*.test.ts`, `src/fleet/*.test.ts` | `bun test` suites (stub fleet plus real CLI on the private socket) |
| `playground.html` | Initial interactive product-direction comparison |
| `console.html` | Earlier terminal-first prototype |
| `.design/drafts/console/terminal-deck/v4.html` | Latest selected coordination mockup |
| `.design/drafts/console/terminal-deck/meta.json` | Selected direction and proposed functionality |
| `.design/design-system.md` | Selected visual tokens and layout constraints |
| `.design/check-coordination.ts` | Focused handler checks using a minimal DOM fixture |
| `.design/shots/` | Saved desktop/phone light/dark renders |
| `docs/HANDOFF.md` | New-session starting point, selected decisions, limits and next action |
| `docs/design/terminal-deck.html` | Byte-identical handoff copy of v4 |
| `docs/design/manifest.json` | Source-linked SHA-256 records for the HTML and preview copies |
| `scripts/check-design.ts` | Portable handler check against the preserved design |
| `AGENTS.md`, `CLAUDE.md` | Entry points that route new coding sessions to the handoff |

The design and documentation pass began without a Git repository. The user subsequently authorized local Git initialization and an initial snapshot on main. Recheck the actual branch, log and working tree when continuing. Remote creation and push were not requested.

## Implemented in the mockup

- Full-window Terminal Deck with distinct host/session hierarchy and no duplicate top session navigation.
- Four synthetic remote roles in a 2x2 pane layout.
- Right-side supervisor request, evidence disclosure, workflow, command history and instruction composer.
- Demo approval and decline, with the next phase still not started while acknowledgement is pending.
- Demo instruction submission, escaped for display and labelled locally queued rather than delivered.
- Preview states for work in progress, disconnection and no output.
- Inspector visibility and terminal text scaling controls.

No live model observation is displayed in v4. The fixtures do not establish that each role has an attachable terminal in the selected runtime.

## Implemented locally: stages 1-2 (2026-11-09, branch `feat-fleet-adapter`)

Scope: MacBook only, private tmux socket, one shell test session with no model. No workstation was contacted, no dependency was installed, no agent was started (`fleet start` launches `claude` and was not used).

- **Stage 1, fleet adapter** (`src/fleet/cli.ts`): wraps agent-fleet 0.3.0 `fleet screen` and `fleet status`; it does not call tmux or SSH itself. Errors are typed: `config`, `session_missing`, `invalid_name`, `cli_failed`, `malformed_output`. Unknown `fleet status` text fails instead of becoming an empty fleet.
- **Finding:** in agent-fleet 0.3.0, `fleet screen <missing>` exits 0 and prints `can't find pane` only on stderr, because capture-pane is piped through awk/tail. The adapter detects it from stderr. A proper exit code belongs in agent-fleet itself.
- **Stage 2, service skeleton** (`src/server.ts`, `src/store.ts`, `src/model.ts`, `index.ts`): `Bun.serve` on `127.0.0.1` only, `GET /api/sessions` and `GET /api/sessions/:name/screen?lines=N`, bun:sqlite registry of known sessions and model observations. Each session carries a model state: `observed`, `configured` (labelled "configured, not observed"), `unknown` (with last observation as history) or `not_applicable` (script session). Observations count as current only for the same runtime instance and within 10 minutes. The fleet CLI exposes no runtime instance yet, so every agent currently shows `unknown` or `configured`. No observation collector exists.
- Run: `FLEET_CONF=/path/fleet.conf bun run serve`. No auth, so it must stay on loopback.

Verification (2026-11-09, this worktree): `bun test` 26 pass / 0 fail, including real-CLI tests that read known tokens from the test session, get explicit errors for a missing session and a broken or absent `fleet.conf`, and confirm the session is still alive after reads. Negative control: removing the missing-pane check makes the missing-session test fail. `bun check` clean. `bun run design:check` still passes.

This is not a workstation integration, terminal bridge or production test. The tests ran on the Mac against a shell session, not an agent.

## Implemented locally: stage 3, read-only terminal (2026-11-09, same branch)

Scope: MacBook only, private test fleet, shell session with no model. Hosts `.15` and `.4` were not contacted for this stage (user: leave `.15` alone for now).

- **agent-fleet change** (separate repo, worktree `~/Development/agent-fleet.worktrees/attach-read-only`, branch `feat/attach-read-only`, commits `2bb3678`, `a13b386`, `957467e`, not pushed, not released): `fleet attach --read-only <session>` runs `tmux attach -f read-only,ignore-size`. Finding: `ignore-size` does not stop a *sole* client from sizing the window, so for local read-only attach the script first sets its own tty to the agent window size (plus status line) and announces it as `OSC 777;fleet-size;W;H`. Remote (`REMOTE_SSH`) attach gets the flags but not the sizing; untested.
- **Viewer** (`src/terminal/viewer.ts`): Bun PTY running `fleet attach --read-only`. Refuses a CLI without that flag instead of attaching writable. No write or resize path.
- **WebSocket** `GET /api/sessions/:name/terminal`: same-origin only (403 otherwise). Any client message, typing or resize, closes the socket with 1008. Closing the socket sends SIGHUP to the viewer; the session keeps running.
- **Page** (`web/index.html`, `web/app.ts`, `web/deck.css` copied from the baseline, `web/live.css`) served at `/`: host-grouped left nav from `/api/sessions` with model label per session, one ghostty-web 0.4.0 pane per running session created at the announced agent size and scaled to fit, supervisor panel saying no supervisor is connected. `ghostty-web` pinned at 0.4.0 (MIT, no dependencies) with approval.
- ghostty-web 0.4.0 throws `RangeError: offset is out of bounds` on an empty `write("")`; the page skips empty writes.
- Local demo: `READONLY_FLEET_BIN=~/Development/agent-fleet.worktrees/attach-read-only/scripts/fleet bun scripts/dev-test-fleet.ts`.

Verification (2026-11-09): `bun test` 33 pass / 0 fail. New real-tmux tests: viewer streams the known tokens, the tmux client is `read-only` + `ignore-size`, agent window stays 120x30 with a 40x10 viewer, closing leaves no client and a live session; missing session exits non-zero; WebSocket: a resize message plus `echo FCINJECT\r` closes with 1008, `FCINJECT` never reaches the pane, window stays 120x30; cross-origin upgrade gets 403 and starts no viewer. agent-fleet stub test: failures 0. Manual check in Chrome (agent-browser), 1440x900, dark and light: tokens and tmux status line render inside the pane; while the page was open tmux listed one client `read-only,ignore-size` at 120x31 and the window stayed 120x30; typing in the page did not reach the pane; closing the browser left 0 clients.

Not covered: agent (`claude`) sessions, remote hosts, several viewers at once, reconnect, auth, the 600px layout, and an accessibility check. Supervisor panel, commands and model collection are still not connected.

## Not implemented in this project

- Workstation service, authenticated HTTP API and remote MCP tools.
- Durable command/request storage and resumable event stream.
- Supervisor command acknowledgement and phase-state adapters.
- Live terminal on a workstation, input, and reconnect. A local read-only viewer exists (stage 3 above).
- Exclusive input leases. Local read-only is enforced by the service and by tmux; auth is not.
- Runtime model metadata and freshness handling.
- Host autostart, supervisor replacement and restart reconciliation.
- Deployment, network configuration and independent workstation credentials.

The mockup's send button writes only browser memory. It does not execute a fleet command. Reloading clears demo actions.

## Verification evidence

During design iteration, the installed design-studio renderer produced desktop 1440x900 and phone 390x844 screenshots in light and dark. The contact sheets were opened and reviewed. After the composer initially extended below the visible panel, the right sidebar was changed so the composer remains outside the scrollable request/history area, then rendered again. These observations are visual review, not a full browser interaction or accessibility test.

During this documentation save, the existing check was rerun:

```bash
bun .design/check-coordination.ts
```

Exit code: 0. It reported checks for the initial fixture, blank input, escaped instruction text, locally queued receipt, approval awaiting acknowledgement, no automatic next-phase start, decline and disconnected refusal.

That script executes the actual draft handlers against a minimal DOM fixture. It does not run Chrome, a real supervisor, a network transport or an actual PTY. Its green result must not be called production verification. The current fixture checks also do not demonstrate restart recovery or malformed persistent-record handling.

## Source checks behind the documentation

The documentation save reread the local package, entry point, selected draft metadata, v4 interaction code and design notes.

Installed integration source checked:

- agent-fleet 0.3.0, `scripts/fleet`, lines 288-373: start, send, fleet-wide decide, human-readable status, screen, watchdog, attach and monitor command.
- phased-delivery 0.2.0, `skills/phased-delivery/SKILL.md`: worktree setup, persistent worker, independent verification, fresh review, phase gates and stop conditions.
- phased-delivery 0.2.0, `README.md`: package contents, Agent-based workers/reviewers and file-based run state.

Those are source checks of installed packages, not a live fleet probe. Do not generalize their interfaces to an uninspected future release.

The HIG passages cited in [interface design](ui-design.md) were read through Docify. The source version and passage IDs are included there.

## Open decisions

1. Actual workstation, OS, execution user, repositories and network route.
2. Authentication and authorization for browser, local session, service and terminal access.
3. Packaging of the host service and client integration; exact API/MCP/CLI contracts.
4. Durable store and machine-readable phase format; synchronization with `run.md` without competing writers.
5. Supervisor wakeup and acknowledgement mechanism, including what happens while it is busy or blocked on a dialog.
6. Mapping Agent subagents to reports versus attachable terminal sessions.
7. Version-pinned Ghostty browser package and PTY implementation.
8. Runtime model observation source and freshness policy for each supported harness.
9. Supervisor rotation, reboot recovery, event retention, backups and restore tests.
10. Single-host MVP versus coordination across several hosts; UI grouping is not a completed distributed scheduler.
11. Budgets, end time, pause/cancel/terminate semantics and standing autonomous permissions.
12. Frontend framework and production state management; current HTML drafts do not select one.

## Suggested implementation order

This is a recommendation, not an approved execution plan.

1. Validate one isolated local session attachment through the existing fleet CLI.
2. Establish authenticated host inventory and read-only runtime state.
3. Implement durable commands, explicit acknowledgements and scoped requests.
4. Connect phased-delivery checkpoints and verified evidence.
5. Replace synthetic terminal content with tested Ghostty/PTY attachment.
6. Add input leases and model observations, then test disconnect and restart recovery.

Before live implementation, write an approved, testable plan and establish a repository/worktree workflow. Keep authorization-sensitive installation and host changes explicit. Do not treat a successful mockup render as permission to deploy.
