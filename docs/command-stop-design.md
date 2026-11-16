Status: proposal, 2026-11-16. Nothing here is implemented. It answers open decision 8 in [implementation-status.md](implementation-status.md) (budgets, stop time, pause and cancel, standing permissions) and needs the owner's choice before any code.

## What exists today

- A command moves `queued` to `delivering` to `delivered` or `delivery_unknown`, then the recipient answers `accepted` or `rejected` and reports `running`, `completed` or `failed` (`src/domain/commands.ts`, `commandTransitions`). The central copy is `centralCommandTransitions` in `src/central/domain/commands.ts`, plus `claimed` for cooperative pulls.
- Only the recipient can end a command early (`command_respond` with `rejected`). The operator who submitted it cannot take it back.
- On the host service a command is delivered right after submit, so it is `queued` only for the moment before `fleet send`. On the cooperative central it stays `queued` until the supervisor claims it, which can be hours if the supervisor is idle. Today there is no way to stop it being claimed later.
- A request has `request_withdraw` for the agent that opened it. Commands have nothing like it.
- No budget, stop time or standing permission is stored by Fleet Control. `fleet decide` writes a fleet-wide rule into agent-fleet's `autonomy.txt`; that is agent-fleet's, not ours.

## Proposal

1. **Withdraw a queued command.** New state `withdrawn`, reachable only from `queued` and only by the operator who submitted it (or any operator, owner's choice). In the central store it runs in the same transaction and with the same `status = 'queued'` check as a claim, so a claim and a withdraw cannot both win. Once `delivering`, `delivered`, `claimed` or `delivery_unknown`, withdraw is refused: the text may already be in the agent's pane, and only the agent can say what it did. A repeated withdraw returns the same result.
2. **Stop time for queued commands.** Optional `notAfter` on submit. A claim or delivery after that time does not happen; the command becomes `expired` instead. This is checked at claim or delivery time, not by a timer, so nothing runs in the background. Nothing already delivered is ever expired.
3. **Pause one target.** A per-session hold: while held, deliveries and claims for that session are refused and commands stay `queued`. Lifting the hold does not deliver anything by itself; the next claim or a manual `command_deliver` does. This is the same rule as the input lease design, which also holds `fleet send` for a leased session.
4. **Cancel running work: not in Fleet Control.** Stopping an agent mid-task means typing into its terminal or killing a process. Both are live terminal input or host process control and need their own approval. A command that is `accepted` or `running` can only be ended by the agent's own report, or by the cooperative settlement an operator already has for claims nobody can report on.
5. **Budgets and standing permissions: out of scope for now.** Fleet Control does not see token spend or tool calls. A budget would be a number nobody enforces. Standing permissions stay in agent-fleet's `autonomy.txt`.

## What each change touches

| Change | Host (SQLite) | Central (PostgreSQL) | Page |
| --- | --- | --- | --- |
| `withdrawn` | new status and transition | new status value; `status` is plain `TEXT` and the runtime role already has `UPDATE (status, updated_at)`, so no schema or grant change | button on a queued command |
| `notAfter` / `expired` | new nullable column | new nullable column; schema change needs a migration and a new rehearsal | field in composer |
| per-target hold | new table | new table and grant | toggle per session |

New central columns or tables change `deploy/cooperative/schema-definition.sql` output and need the upgrade rehearsal again before a release.

## Questions for the owner

1. Withdraw of queued commands: yes, and only by the submitting operator or by any operator? Recommended: yes, any operator, since today there is one.
2. Stop time on submit (`notAfter`, becomes `expired`)? Recommended: yes, but after withdraw.
3. Per-target hold? Recommended: later, together with input leases.
4. Agree that cancelling running work and budgets stay outside Fleet Control for now?
