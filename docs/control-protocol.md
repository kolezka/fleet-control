# Control protocol

Status: proposed service contract. The HTML mockup illustrates parts of this protocol but does not implement remote delivery, persistence or authentication.

## Local session to remote supervisor

A request such as "ask the supervisor to start the next phase" follows this path:

1. The local session submits an authorized instruction through MCP.
2. The host service validates identity and scope, then durably stores the command.
3. A host adapter notifies the supervisor that a command is pending.
4. The supervisor reads it and explicitly accepts or rejects it.
5. Accepted work emits execution and outcome events with linked evidence.

The browser and optional operator CLI use the same underlying operation. Example API/tool responsibilities are submitting an instruction, reading a run, listing requests, resolving one request and reading events. Exact endpoint paths, tool names and schemas remain open; there are no implemented Fleet Control MCP tools yet.

## Commands

Proposed command fields:

| Field | Purpose |
| --- | --- |
| commandId, idempotencyKey | Identify one intent across retries |
| runId, sessionId | Identify the intended task and recipient |
| runtimeInstance | Reject acknowledgements from replaced sessions where applicable |
| actor, authorizationScope | Record who acted and under which permission |
| expectedRevision | Prevent a command from applying to changed phase state |
| kind, payload | Describe a validated operation, not an arbitrary shell command |
| createdAt, status, receipts | Record delivery and execution evidence |

State meanings:

- **Queued:** the host accepted the record into durable storage.
- **Delivered:** the transport delivered it to the recipient channel.
- **Accepted / rejected:** the supervisor explicitly responded to the instruction.
- **Running:** execution began and is linked to this command.
- **Completed / failed:** an outcome was reported with supporting evidence.
- **Pending or unknown:** reconciliation is required; a timeout is not success or proof of nonexecution.

Retry with the same identity. Do not claim exactly-once execution merely because an API accepts idempotency keys. The adapter must handle a crash between executing an operation and recording its receipt.

A candidate first adapter uses `fleet send` to notify the supervisor about a structured queued command. Existing permission-dialog and typed-input guards remain in force. Pasting a message is not supervisor acknowledgement. A proposed host command or tool must let the supervisor read and acknowledge pending work.

## Requests from the supervisor

A request may ask for phase approval, clarification, a scope change or help with a blocker. It should contain:

- request ID and originating supervisor instance;
- run, phase and expected revision;
- question, proposed action and affected scope;
- evidence links and allowed responses;
- whether it blocks the phase;
- status and resolution actor/time.

The operator can answer in Terminal Deck or through the local assistant. The local assistant relays a real user decision; it does not create authority by claiming to speak for the user. Autonomous actions require a separate standing authorization.

A resolution applies only to the named request and revision. A changed revision must invalidate or require reconfirmation of an old approval. Concurrent answers from two clients must conflict visibly rather than both apply.

`fleet decide` is not this operation: the inspected CLI adds a standing fleet-wide rule and broadcasts it. Use that only for an actual fleet-wide policy decision.

## Delivery workflow

The intended phased-delivery sequence remains:

1. Plan and resolve blocking product decisions.
2. Assign a bounded phase to the persistent worker in its worktree.
3. Receive the worker's report as an unverified claim.
4. Have the orchestrator rerun checks and inspect the changed revision.
5. Obtain a fresh independent review.
6. Resolve required human decisions.
7. Checkpoint the result before dispatching the next phase.

Approval is not evidence that the next phase started. Worker completion is not orchestrator verification. Watchdog health is not acceptance. UI state must reflect these distinctions.

The inspected skill permits at most three fix rounds per phase, then requires stopping and reporting. It preserves a worker across phases where possible. The service integration must not erase those boundaries.

## Events and notification

Proposed event categories include command receipts, supervisor requests, phase transitions, verification results, review outcomes, session replacement, host connection freshness and observed-model changes.

Events need stable IDs, ordering/cursors, actor, timestamp and links to the relevant run, command, request and revision. The browser may consume a resumable event stream. After reconnecting it must reconcile the current snapshot with events, not replay stale approvals.

MCP gives the local session tools to read or wait for events. It does not, by itself, guarantee that an inactive chat session will wake. Choose a supported harness notification, monitor or polling adapter before promising push behavior.

When the MacBook is offline, the host retains requests. Existing authorization can permit unrelated work to continue, but unanswered gates remain blocked. Browser disconnect, supervisor failure and workstation failure are separate states.

## Terminal channel

Proposed path: browser ghostty-web, authenticated WebSocket, host PTY, existing `fleet attach`, existing tmux session.

- Opening a view attaches; it does not relaunch the agent.
- Closing a view detaches; it does not kill the session.
- Default access is read-only, enforced at the host boundary rather than by hiding the browser input box.
- Writing requires a separately authorized, exclusive input lease bound to the session instance.
- Phase approval must not silently grant terminal access.
- Reconnect must not automatically restore stale write ownership.
- Resize, Unicode, scrollback, terminal escape sequences and full-screen agent UI behavior require empirical tests.

The current fleet attach branch is interactive and supplies neither the proposed read-only guarantee nor input-lease enforcement. Those are implementation gaps.

## State integrity and security

The service should be the shared authority for command/request records; phase outcomes come from the authorized orchestrator with revision-bound evidence. Define how machine-readable records and phased-delivery Markdown checkpoints stay consistent before building both writers.

Do not scrape terminal text as the authoritative source of completion, approval or model identity. A failed or malformed state read must be explicit, not converted into "idle", an empty fleet or a successful run.

Use authenticated clients, per-operation authorization, validated session IDs, audit records and trusted fleet configuration. Preserve existing permission and workspace-trust gates. Pause-new-work, cancel-current-work and terminate-session are different operations and need separate semantics and permissions.

## Mockup behavior

In Terminal Deck v4, submit adds an in-memory demo row only. It says queued locally, not delivered or accepted. Approve marks the example decision as awaiting acknowledgement and leaves the next phase not started. Decline does not authorize continuation. Reloading the page discards these demo actions.
