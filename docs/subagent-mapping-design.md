Status: proposal, 2026-11-16. Nothing here is implemented. It answers open decision 5 in [implementation-status.md](implementation-status.md): how phased-delivery's Agent subagents show up in Fleet Control.

## What happens today

phased-delivery 0.2.0 (`skills/phased-delivery/SKILL.md`) runs one worker and one fresh reviewer per phase as `Agent` tool calls inside the orchestrator's Claude Code session. They have no tmux pane of their own, so `fleet status` cannot list them and `fleet send` cannot reach them. The orchestrator continues the worker with `SendMessage`; the worker ends each phase with a phase report (`references/phase-report.md`), a file in the run's git dir next to `run.md`.

Fleet Control sees only:

- the orchestrator's terminal, when the orchestrator itself runs in a fleet session;
- the run record (`runs` table: phase, revision, phase status), written by `phase_update` or by `scripts/run-file-sync.ts` from the `run.md` phase table;
- requests the orchestrator opens with `request_create`.

`scripts/run-file-sync.ts` reads the Status and Tip columns. It ignores `Verified by orchestrator` and `Review`.

## Proposal

1. **Subagents are reported, not addressed.** No session, pane or command target for a worker or reviewer. Commands keep going to the orchestrator's session, which decides what to tell its worker. This keeps one place that can talk to the worker, as the skill requires, and needs no change to agent-fleet.
2. **The run record names who did what, in separate fields.** `run-file-sync` would also read the `Worker:` line and, for the current phase, the `Verified by orchestrator` and `Review` cells, and write them into the phase status as labelled parts, for example `done at 1a2b3c4; worker: worker-auth; orchestrator ran: bun test exit 0; review: APPROVE (route-gpt-sol); 2 of 5 done`. The page shows them as written. `run.md` holds no worker claim: the worker's GREEN lives only in its phase report, and the table records what the orchestrator re-ran and what the reviewer said. Neither is human approval, which stays a request answered on the page.
3. **A changed verdict or verification is not new work.** Only a new tip or fix round starts a new revision (today's rule from #150). Filling in the review cell for the same tip updates the status without staling open requests.
4. **No phase report content in the service.** Reports stay files in the run's git dir. The service gets the summary above and the tip; anyone who needs the report reads it on the workstation. This keeps the 500 character phase status limit and keeps worker text, which may quote secrets from logs, out of the database.

## What this does not cover

- Subagents started by an agent outside phased-delivery. They have no run record; the parent session's terminal is the only view.
- Live progress of a running worker. The service learns about a phase when `run.md` changes.
- Whether the skill calls `run-file-sync` at each checkpoint (open decision 3). Without that, an operator runs it by hand.

## Owner questions

1. Keep subagents out of the session list and command targets, visible only through the run record? Recommended: yes.
2. Extend `run-file-sync` to mirror the worker name, the orchestrator's checks and the review verdict as separate labelled parts of the phase status? Recommended: yes, local change with tests, no skill change.
