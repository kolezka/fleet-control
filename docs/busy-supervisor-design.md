Status: proposal, 2026-11-16. Nothing here is implemented. It answers open decision 4 in [implementation-status.md](implementation-status.md): what a command does when the supervisor is busy or a dialog is open.

## What happens today

`fleet send` (`paste_file` in `vendor/agent-fleet/scripts/watchdog.sh`, pinned `3bd26d8`) refuses to paste in these cases and says so on stderr:

| Exit | When | Text reached the pane? |
| --- | --- | --- |
| 2 | no such session | no |
| 3 | dialog open before the paste (`dialog open, not sent`) | no |
| 3 | dialog opened during the paste (`Enter not pressed. The pasted text may still be in the input line.`) | maybe, without Enter |
| 4 | text in the input line before the paste (`text in the input line, not sent`) | no |
| 4 | other text appeared during the paste | yes, then cleared with C-u or left there |
| 5 | pasted and Enter pressed, first line not found | probably |
| 6, 8 | blank message, message quotes dialog text | no |
| 7 | a tmux step failed | depends on the step |

Fleet Control's `classify` (`src/domain/delivery.ts`) accepts only exit 0 with the exact `<target>: delivered` line. Every other result becomes `delivery_unknown`, which is never retried. That is safe, but it loses information: when a dialog was open before the paste, the agent never saw the text, yet the operator is told the outcome is unknown and must inspect the pane.

A busy agent (working, no dialog) is not refused: the paste lands in Claude Code's input and is read when the turn ends. That is the intended behaviour and stays.

## Proposal

1. **Record a known refusal as its own outcome.** New status `not_delivered`, set only when the exit code and the whole stderr line both match one of the "before the paste" rows above (2, 3 with `dialog open, not sent`, 4 with `text in the input line, not sent`, 6, 8). Anything else stays `delivery_unknown`. Matching the exact line means a changed agent-fleet message falls back to unknown, never to a wrong "not delivered".
2. **No automatic retry.** `not_delivered` is final for that command, like `delivery_unknown`. The operator submits again with a new idempotency key when the dialog is gone. Retrying automatically would be a recovery policy that needs the owner's decision, and a dialog may stay open for a long time.
3. **Show the reason on the page:** "Not sent: a dialog was open" or "Not sent: someone was typing", next to the command.
4. **Cooperative path:** not affected. A cooperative supervisor pulls work when it is ready, so a dialog only delays the claim.

The pinned CLI test fleet can check rows 2, 3 and 4 with private tmux sockets, as the existing `src/terminal/viewer-send.test.ts` does.

## Questions for the owner

1. Add `not_delivered` for refusals that provably happened before the paste? Recommended: yes.
2. Keep "no automatic retry" for it, so the operator resubmits by hand? Recommended: yes.
