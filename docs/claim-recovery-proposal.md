# Claim recovery for a dead incarnation

Status: the owner chose option A, with settlement allowed only after the claiming incarnation is inactive or its identity retired. A is implemented in `src/central/cooperative-settlement.ts`. B and C are not implemented.

## Current behaviour

- A cooperative claim moves a command from `queued` to `claimed` and records the claiming incarnation (`src/central/cooperative-claims.ts`). A trigger then blocks every update and delete of that command row.
- Lifecycle reports (`accepted`, `running`, `completed`, `failed`, `rejected`) are written only by the incarnation that holds the claim, and only while it is active (`src/central/cooperative-lifecycle.ts`).
- Activating a new incarnation for the same identity deactivates the old one (`src/central/incarnations.ts`).
- So when an incarnation dies or is replaced, its claims are frozen. Nobody can report on them. The command stays `claimed` forever.
- An operator can append reconciliation assertions (`unknown`, `completed`, `failed`, `not-executed`) with evidence (`src/central/cooperative-reconciliation.ts`). They are evidence only. They change no command or lifecycle state.
- A claim whose response never reached the adapter (`src/central/cooperative-claim-response-risk.test.ts`) is in the same frozen state, even though the work may never have started.

Fixed owner decisions: no automatic requeue, no successor command, unknown outcomes are never retried automatically.

## What is missing

1. A way to say "this claim is settled" that inspection and the UI can show, so frozen claims do not look like live work.
2. A way for the work's real outcome to be recorded when it is known after the incarnation was replaced.

## Options

### A. Operator settlement only (smallest change)

Add one terminal, append-only "settlement" record per claim, written only by an operator. It carries a disposition (`completed`, `failed`, `not-executed`, `unknown`) and evidence, and requires that the claiming incarnation is no longer active. Inspection shows the claim as settled. The command row stays `claimed`; nothing re-runs.

- Gain: frozen claims become visibly closed. Human judgement stays in charge.
- Cost: every dead-incarnation claim needs a human. `unknown` stays `unknown` forever if nobody knows.
- Risk: low. No new writer for lifecycle state.

### B. Late reports from a replaced incarnation (plus A)

A replaced incarnation keeps a narrow right: it may still write lifecycle reports for claims it already holds, but may not claim new work. Fencing then stops new work, not the truth about old work. Reports after replacement are marked late in inspection. Once an operator settles the claim (A), late reports are refused.

- Gain: a slow but alive worker can still report what really happened, which is the best evidence there is.
- Cost: an old token keeps some write power after replacement. Needs an expiry (for example 24 hours) and the token must still match.
- Risk: medium. A leaked old token can write a false outcome for its own claims only, not touch other work.

### C. Adoption by the replacement incarnation (plus A)

The new incarnation of the same identity may adopt an old claim, but may only report `not-executed` (if it can prove the work never started) or `unknown`. It may never execute the command.

- Gain: no human needed for the case where the new worker can prove nothing ran.
- Cost: "prove it never started" needs host-side evidence (the executor journal) that no runtime uses yet.
- Risk: high until the journal is wired in. Not recommended now.

## Recommendation

Start with A. Add B only if late reports turn out to be common. Leave C until the host executor journal is part of a real runtime.

## Decision

1. A approved and implemented.
2. Settlement only after the incarnation is inactive or its identity retired. No override for a live incarnation.
3. B and C are not implemented. Revisit B only if late reports turn out to be common.
