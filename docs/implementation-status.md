# Implementation status and next decisions

Recorded 2026-11-09. This is a source-scoped status report for the local Fleet Control prototype, not an inventory of unrelated services on the machine.

## Existing project files

| File | Current purpose |
| --- | --- |
| `package.json` | Private Bun project; typecheck script; Bun types and TypeScript declarations |
| `index.ts` | Starter greeting, not an application server |
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

## Not implemented in this project

- Workstation service, authenticated HTTP API and remote MCP tools.
- Durable command/request storage and resumable event stream.
- Supervisor command acknowledgement and phase-state adapters.
- Browser Ghostty renderer, PTY bridge and live fleet attachment.
- Server-enforced read-only access and exclusive input leases.
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
