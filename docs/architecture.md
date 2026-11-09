# Architecture

Status: remote supervisor and thin MacBook client are agreed. Component boundaries below are the proposed implementation of that direction.

## Responsibilities

| Component | Location | Responsibility |
| --- | --- | --- |
| Operator | MacBook or another authorized client | Set goals, change scope and answer approval requests |
| Local assistant session | MacBook | Relay authorized instructions, read progress and present requests through MCP |
| Terminal Deck | Browser | Display host/session hierarchy, terminal output, workflow and requests |
| Fleet Control service | Workstation | Authenticate clients, store commands and decisions, expose API/MCP and publish events |
| Supervisor | Workstation | Decompose work, coordinate agents, verify claims and maintain phase state |
| Worker | Workstation | Implement only the assigned phase in an isolated worktree |
| Reviewer | Workstation | Independently review the assigned phase and revision |
| Watchdog | Workstation | Observe session health and apply authorized lifecycle policy |
| Terminal adapter | Workstation | Bridge authenticated terminal clients to existing sessions through a PTY |

The service, supervisor and watchdog have different jobs. The service is a normal program, not a model conversation. It must retain commands and requests when the supervisor session is replaced. A healthy process is not proof of a completed phase.

## MacBook as a client

Closing the browser, ending the local assistant session or sleeping the MacBook must not cancel already-authorized host work. The workstation must have its own credentials and runtime configuration rather than depend on a laptop's forwarded SSH agent or a laptop-hosted process.

A human gate remains blocked while the operator is offline. The supervisor may continue unrelated, already-authorized work, but disconnection is never approval. When the client returns, it retrieves current state and events after its last cursor.

This requirement concerns client disconnection. Surviving a workstation reboot, database loss or supervisor crash requires a separate recovery design and tests. tmux alone is not a durable workflow engine.

## Combining agent-fleet and phased-delivery

agent-fleet handles the fleet's sessions and watchdog. phased-delivery governs delivery inside an orchestrating session: a persistent worker performs one phase, the orchestrator reruns its checks, a fresh reviewer reviews the phase, and the required human gate is resolved before continuing.

For multiple independent scopes, a fleet session may itself orchestrate a phased-delivery run. Do not automatically assign a platform to each agent. Decompose around work ownership and dependencies, and make one actor responsible for integration. Multiple worktrees do not prevent semantic conflicts in shared contracts.

Each phased run keeps one worker where it can be continued. Fresh reviewers should be from another model family where the configured routing supports it. Fix rounds, stop conditions, budgets and permission policy must remain explicit.

### Verified package boundaries

Inspected installed versions: agent-fleet 0.3.0 and phased-delivery 0.2.0.

- agent-fleet exposes CLI operations including `start`, `send`, `status`, `attach`, `decide` and watchdog control.
- `fleet attach` selects the fleet tmux socket and supports a local host or SSH. Its local branch is used when `REMOTE_SSH` is empty.
- The inspected attach implementation is interactive. It is not a browser read-only transport or an exclusive input-lease implementation.
- `fleet status` prints human-readable session/log/context output. A structured status and explicit error contract are still needed for the proposed service.
- `fleet decide` writes a standing rule to `autonomy.txt`, syncs it and broadcasts it. It is not a phase-revision approval API.
- phased-delivery is a skill plus reference formats in the inspected package. Its README explicitly says it supplies no agents, hooks, MCP servers or commands.
- Its worker and reviewer are `Agent` calls. They do not automatically have independently attachable tmux terminals.

Therefore the four terminal panes in the mockup illustrate roles, not verified runtime terminal availability. A production session record must distinguish an attachable terminal from a subagent report/event stream. Do not silently reimplement subagents as separate CLI processes merely to match the mockup.

## Three channels

**Control:** the local assistant uses MCP, the browser uses HTTP, and an optional operator CLI uses the same host service. They share command and decision semantics.

**Events:** the host records ordered lifecycle, workflow, request and model-observation events. A browser stream can resume after a cursor. The local assistant needs a supported wait/poll/notification mechanism; MCP tool definitions alone do not guarantee unsolicited wakeups.

**Terminal:** ghostty-web in the browser connects through an authenticated WebSocket and host PTY to `fleet attach`. Attach to the existing session instead of starting another agent when a pane opens. Closing a pane must detach the viewer, not terminate the session.

The browser implementation would use Ghostty-derived WASM terminal emulation, not embed a native Ghostty application window. Full-screen TUIs, Unicode, resize, reconnect and input behavior need testing against the selected package version.

## Ownership and persistence

Proposed ownership:

- Host service: durable commands, request resolutions, authorization records, event history and client cursors.
- Supervisor/orchestrator: phase progression and verified outcomes, reported with evidence.
- Session runtime: process/session identity, terminal output and observed model metadata.
- Browser: temporary view choices and unsent text, not authoritative workflow state.

Bun is the project runtime. SQLite is a proposed host-local store, not an installed production database in this project. Define the machine-readable phase format and its relationship to phased-delivery's `run.md` before implementation. Do not let two writable stores independently decide whether a phase is approved or complete.

Keep stable run and session identities independent of PID. A restarted process or replaced supervisor needs an instance/generation identity so old acknowledgements and input leases cannot attach to the wrong actor.

## Trust boundary

Expose authenticated, allowlisted operations, not arbitrary shell strings. Treat fleet configuration as trusted operator configuration, not request content. Terminal write access is shell authority and must be authorized separately from a phase approval. Runtime credentials remain on the host; client credentials grant only the intended control scope.

See [control protocol](control-protocol.md) for proposed states and [installation](installation.md) for machine responsibilities.
