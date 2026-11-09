# Fleet Control design context

## Goal

Replace the console prototype's visually noisy presentation with a restrained working console. The user rejected the current appearance as tacky and asked for design-studio alternatives, not a live terminal implementation.

## Source

- `console.html` is a single-file HTML, CSS and JavaScript prototype.
- Bun project initialized in this folder. Design work began before Git initialization; the user later authorized an initial local snapshot on main. Check current Git state when resuming.
- No framework, actual terminal emulator, PTY server or live agents are connected.
- All session output, phase outcomes and timestamps are synthetic fixtures. Preserve that disclosure.
- Preserve `console.html`; create proposals only under `.design/`.

## Required behavior

- The sidebar is the only host/session navigation. No repeated top tabs.
- Selecting runner-01 shows supervisor, worker-api, reviewer-phase-2 and watchdog together. Four example sessions use a 2x2 grid.
- Selecting a session within that host highlights it without removing the others.
- Supervisor is remote by explicit user approval. The MacBook is a client, not an execution dependency.
- The user requested a full-window layout without outer border, margin or radius; phase details move from the bottom tray to a right sidebar and permanent top preview fields are removed.
- Default attachment is read-only. Input lease and approval controls are demos only.
- Closing a view must not terminate the session in the future implementation.

## Existing fixture

Shared task: task-control-api. Example run demo-42. Phase 2, command acknowledgements. Revision 7 / a1b2c3d.

- supervisor: runner-01, Orchestrator, waiting for approval. v1 and v2 used local-dev; v3 reflects the user's approved remote-supervisor architecture.
- worker-api: runner-01, Worker, report submitted.
- reviewer-phase-2: runner-01, Reviewer, review accepted.
- watchdog: runner-01, Watchdog, observing sessions.
- Phases: Contract done; Commands awaiting approval; Read API next.
- Acceptance: example worker test exit 0, orchestrator rerun exit 0, independent review accepted.
- Events: review.accepted at 09:41:14; verification.completed at 09:41:09; worker.report_received at 09:40:54.
- Disconnect means unknown execution state, not stopped. Last known output remains visible.
- Paths and commands include worktrees/control-api and bun test tests/commands.test.ts.

## Integration constraints

Inspected installed agent-fleet 0.3.0 provides fleet attach, start, send, status and decide. Attach handles the fleet socket and SSH, but its inspected implementation is interactive, not a read-only terminal transport. The installed phased-delivery 0.2.0 is a skill with run.md and phase reports; it has no CLI in that package. Workers and reviewers are Agent calls, not inherently separate tmux sessions. The fixture is an interaction concept, not a claim that those terminals already exist.

Proposed production direction: ghostty-web, authenticated Bun WebSocket bridge, PTY invoking fleet attach, plus structured state and scoped phase decisions. Reuse CLI behavior. PIDs are diagnostic metadata, not durable identities. No dependencies or live session access authorized by this design task.

## First-round directions

- Workbench: fixed context inspector, one large worker surface beside two supporting surfaces, quiet system UI.
- Terminal Deck: three equal-height terminal columns, compact sidebar, phase decisions in a bottom tray.

Use sans-serif for application navigation and labels, monospace only for terminal output and technical values. Minimal accent, no decorative logos, fake window chrome, glows, oversized titles or repeated demo badges. A small persistent sample-data notice is sufficient.

The user selected Terminal Deck. Its design-system.md governs subsequent drafts. v2 established distinct host headers and nested sessions; v3 keeps that hierarchy in a full-window layout with a right inspector and a compact icon toolbar. The selected direction supports light and dark through the theme query parameter and adapts to narrow widths. The remote supervisor architecture is approved, but live terminal implementation, credentials, dependency installation and deployment are not authorized by these design changes.

## Supervisor coordination proposal

The user asked how the local session controls a remote supervisor and requested visible supervisor requests and workflow. v4 adds a right-side request, evidence disclosure, workflow, command/response history and demo instruction composer. Command submission is visibly distinct from supervisor acceptance and completion. The new controls are mockups, not a backend implementation. Proposed MCP/HTTP/CLI roles, actor authority, command identities and request revisions are in supervisor-protocol.md.

Docify was queried again for apple-his@1.0.0. Layout > Visual hierarchy (p_28f2e1d117a0deb3a407) and Typography > Conveying hierarchy (p_757f05c34573591c99eb) support the presentation choices. Feedback/progress search returned weak_match; no notification-specific rule is claimed from it.

## Approved runtime direction

Supervisor, execution and durable run state belong on the remote host. The MacBook communicates as a client and need not stay online. Disconnection does not cancel host work or count as approval. API service and watchdog remain independent of the supervisor model session. Recovery from a host reboot or supervisor failure needs explicit checkpoint and idempotency design; tmux alone is not that recovery mechanism. Reuse agent-fleet CLI on the host, extend phased-delivery for structured state and scoped decisions. No host access or service has been configured in this design round.

The attempt to capture this initiative in Hindsight was denied by the permission gate. These local design records retain the user's decision; no successful Hindsight write is claimed.

## Apple HIG grounding requested during this design round

Retrieved through Docify from apple-his@1.0.0, active generation 1, downloaded 2026-11-09. This is the registered snapshot version, not a macOS version. The source reports a partial graph; the cited text passages were available.

- Layout > Visual hierarchy, p_28f2e1d117a0deb3a407: order by importance, align and indent hierarchy, group related functions, use progressive disclosure. Apply to a single sidebar and a hideable phase inspector, leaving the terminal content dominant.
- Typography > Using system fonts, p_40ab8ffbd38705ce55d5: system text styles establish hierarchy and scale; minimize typeface families. Use system sans for controls and system monospace for terminal content, without embedding Apple's font files.
- Accessibility > Vision, p_c0fddc877c056647381b: native macOS custom text defaults are 13 pt, minimum 10 pt; guidance calls for larger text support and sufficient contrast. CSS pixels are not a claim of native point-size compliance. Drafts expose terminal text scaling and normal browser zoom remains available.
- Color > Liquid Glass color, p_64aa889fd38a29d73e40: apply color sparingly, reserve emphasis for status and primary actions, preserve contrast. Use quiet chrome and one prominent phase action, not colored controls everywhere.

This web proposal follows those principles but does not claim native Liquid Glass rendering, native accessibility semantics or a completed HIG compliance audit. The searches did not return dedicated sidebar or inspector sections, so no specific rules from those sections are attributed here.
