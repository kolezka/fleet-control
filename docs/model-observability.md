# Session model visibility

Status: a Claude Code observer exists in the feat-fleet-adapter worktree (see "Implemented source" below). It has been checked against real Claude Code 2.1.319 processes on the MacBook, not against an agent started by agent-fleet. Other harnesses have no observer.

## What the user should see

Show a compact model label beside the session name in its terminal header. Details should expose the full model identity, observation source and time. Avoid a new global model selector or decorative badge for every metadata value.

Distinguish these states:

| State | Meaning | Presentation |
| --- | --- | --- |
| Observed | Runtime evidence identifies the model for a specific request or current execution | Model label plus observation provenance |
| Configured only | A configuration or launch option names a model, but execution is unobserved | Explicitly label it configured, not in use |
| Unknown or stale | No reliable current observation is available | Unknown, with a separately labelled last observation if available |
| Not applicable | This actor is known not to use a model, such as a shell watchdog | No model or Shell |

An absent field is not proof that a process uses no model. A last-completed-request model is not automatically the model of a new in-flight request.

## Why configuration is not enough

A session may change models, delegate to another model, resolve a routing alias or use a fallback. A role name, default configuration, PID, launch command or terminal title does not establish which model handled a particular turn.

Keep configured intent and observed execution separate. Display the strongest supported fact instead of collapsing both into one `model` label. A provider-reported model identity is only as precise as that provider's contract; do not invent an underlying model behind an unresolved alias.

## Proposed observation record

- Stable session ID and runtime-instance ID.
- Role and agent engine/harness.
- Configured provider/model or routing alias, if available.
- Observed provider and model identifier, if available.
- Request or turn ID tying the observation to actual work.
- Observation source and timestamp.
- Freshness/availability status.
- Parent/child relationship for delegated sessions.

The workstation adapter should collect this from documented runtime events, responses or another validated instrumentation boundary. Do not promise a specific hook field until it is verified for the chosen harness version. Do not infer identity by scraping prose from the terminal.

If parent and child use different models, show them independently. The supervisor model must not be copied onto every worker or reviewer.

## Disconnects and replacements

On disconnect, retain the last observation as historical and mark current information unavailable or stale. A timestamp refresh caused by polling must not make an old model observation current.

When a session is replaced, bind new observations to its new runtime instance. Do not carry an old instance's model label forward as if it were a verified observation of the replacement.

## Acceptance checks to implement

- An observed model appears with its source and time.
- Configured-only and observed values remain visibly distinct.
- A fallback or model switch updates the relevant session and turn.
- A child model does not overwrite its parent's model.
- Missing and malformed model metadata produce different explicit availability outcomes.
- Disconnection and supervisor replacement do not promote stale observations to current state.
- A known shell watchdog shows no model, while an uninstrumented agent shows unknown.
- A label is never presented as verified runtime data when it comes only from a static example fixture.

Covered by tests in `src/model.test.ts`, `src/observe/claude.test.ts` and `src/server.test.ts`: observed with source and time, configured vs observed, model switch, child model not overwriting the parent, missing vs malformed, replacement and disconnect not promoting history, script shows no model, uninstrumented agent shows unknown. Not covered: a fallback inside one turn, and other harnesses.

## Implemented source (Claude Code)

`src/observe/claude.ts`, read-only, runs on the host that owns the fleet:

1. `tmux -L fleet-<FLEET> list-panes -s -t =<session>` gives pane pids (same socket agent-fleet uses).
2. `ps -A -o pid=,ppid=,lstart=,args=` (C locale, UTC) finds the newest child whose argv starts with `claude`, the same rule as agent-fleet's `claude_pid()`.
3. `<config>/sessions/<pid>.json` (written by Claude Code) gives `sessionId`, `cwd` and `procStart`. `procStart` must equal the process start time, so a reused pid cannot match an old file.
4. The last 512 KiB of `<config>/projects/<cwd encoded>/<sessionId>.jsonl` is read backwards for the last assistant record with `isSidechain: false`, a matching `sessionId` and a `message.model` other than `<synthetic>`.

`<config>` is `CLAUDE_CONFIG_DIR` from fleet.conf, the environment, or `~/.claude`. Runtime instance is `claude:<pid>:<sessionId>`. Source label: `claude-code transcript`.

These files are Claude Code internals, not a documented contract. A format change shows as `unknown` with a "malformed" or "unavailable" reason, never as a guessed model. Verified on Claude Code 2.1.319 (macOS); recheck after upgrades.

Freshness policy: the observation is current only while its runtime instance is confirmed alive by a check made for the same API read. The time shown is the time of the last main-thread turn; an idle agent keeps showing the model of its last turn with that time. Stored rows are history only; a new row is written when the model, turn time or instance changes. A conf with `REMOTE_SSH` or `REMOTE_USER` disables the observer, because the process and files are on another host or user; each host's own service observes its sessions.
