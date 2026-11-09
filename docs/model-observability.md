# Session model visibility

Status: requested by the user; runtime collection and UI display are not implemented in Terminal Deck v4. The schema and adapter behavior below are proposals.

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

These are future acceptance criteria, not tests that have already passed.
