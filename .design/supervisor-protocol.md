# Supervisor control proposal

This is a proposed integration contract for Fleet Control, not an implemented service. The approved architecture keeps the supervisor and execution on a remote host; the MacBook is a client that need not stay online.

## Separate channels

- Terminal: ghostty-web over an authenticated WebSocket/PTY bridge to fleet attach. No shell bridge has been implemented here.
- Control: local assistant session through MCP, browser through HTTP, and operator CLI through the same host service. These are adapters over one command and decision store, not separate owners of state.
- Events: ordered host-side event history, streamed to the browser with a resume cursor. The local assistant can read or wait for relevant events using MCP tools backed by the same history. The mechanism that wakes a local chat session depends on its harness; an MCP tool declaration alone does not guarantee unsolicited delivery.

## Authority

The local session relays user-authorized instructions; it is not a second autonomous supervisor with authority to change scope or approve its own sensitive requests. Request responses carry actor identity and authorization scope. A human decision can arrive from either the browser or the local session when the session is actually relaying it.

## Command lifecycle

1. Host service validates and durably queues a command with a run ID, command ID, actor, scope and idempotency key.
2. A host adapter delivers or signals pending work to the supervisor.
3. Supervisor explicitly accepts or rejects it.
4. Accepted work emits start and completion/failure events with linked evidence.

Queued, delivered, accepted and completed are distinct. A paste receipt from fleet send is delivery evidence only, not supervisor acknowledgement. Ambiguous timeouts remain unknown or pending; retry must preserve the same identity and reconcile before executing again.

## Existing CLI reuse

The inspected agent-fleet CLI provides start, status, send, attach, decide and watchdog operations. Reuse it through validated, allowlisted operations and trusted fleet configuration. Do not expose arbitrary shell strings as an API command.

A thin first adapter can use fleet send to notify an idle supervisor that a command is pending. Its existing dialog/input guards remain in force. A refusal leaves the command pending or blocked, not successful. The supervisor reads the structured command and acknowledges it through a proposed host CLI or MCP tool. This acknowledgement path, JSON status and durable event output still need implementation.

fleet decide changes a standing fleet-wide rule and broadcasts it; it must not stand in for an approval of one phase revision.

The installed phased-delivery package is a skill and file-based run protocol. Extend its checkpoint and decision steps to publish structured state and consume scoped approvals. Do not infer completion or approval by scraping terminal text.

## Supervisor requests

Each request names its ID, kind, run, phase, expected revision, question, allowed responses and scope. Proposed kinds: approval, clarification, scope change and blocker. A response resolves only that request. A changed phase revision invalidates an old approval. Concurrent answers from two clients must be detected, not both applied.

The host retains unanswered requests while the MacBook is offline. Unaffected work can continue inside existing authorization. Human gates remain blocked. Host or supervisor restart recovery is separate from a client disconnect and requires explicit reconciliation.

## UI proposal

Right sidebar order: pending request, compact workflow, command/response history, instruction composer. Evidence and scope are behind a disclosure control. Each exchange names its actor and receipt state. The design uses the selected Terminal Deck tokens and one left navigation hierarchy.

The v4 mockup uses synthetic records and in-memory UI state only. Its send action queues a demo row, not an API request. Approving the fixture shows acknowledgement pending and does not mark phase 3 running. No persistence, delivery or exactly-once execution guarantee is claimed by the mockup.

## HIG grounding

Docify apple-his@1.0.0, Layout > Visual hierarchy, p_28f2e1d117a0deb3a407 supports ordering by importance, grouping related functions and progressive disclosure. Typography > Conveying hierarchy, p_757f05c34573591c99eb supports consistent typography and relative emphasis. A focused feedback/status search returned weak_match; this proposal does not attribute unverified notification or progress-specific rules to Apple.
