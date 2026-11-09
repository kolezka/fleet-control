# agent-fleet: `fleet send` refuses with exit 4 when the tmux server has `NO_COLOR=1`

Found 2026-11-09 during the Fleet Control stage 4 supervisor test. Not fixed. For another session to pick up in the agent-fleet repo (`~/Development/agent-fleet`, origin `kolezka/agent-fleet`).

## Symptom

`fleet send <session> <file>` to an idle Claude Code session prints

```
<session>: text in the input line, not sent
```

and exits 4, although nobody typed anything. The input line only shows Claude Code's placeholder suggestion, for example `❯ Try "how does <filepath> work?"`.

## Cause

`scripts/watchdog.sh`, `input_text()` (line 63 at agent-fleet `main` 8a1bd2c):

```bash
input_text() { # the text in the input line; empty when it is empty or shows a dim suggestion
  local l; l=$(tmux capture-pane -p -e -t "$1" | rg '❯' | tail -1)
  [[ "$l" == *$'\e[2m'* ]] && return 0
  ...
```

It tells a suggestion from real typing only by the dim attribute `\e[2m`. When Claude Code runs with `NO_COLOR=1` it draws the suggestion with no SGR codes at all, so the check falls through, the suggestion text is returned, and `user_typing` reports typing. `paste_file` then returns 4.

Captured prompt line (`capture-pane -p -e`, `od -c`), same Claude Code 2.1.319, Haiku session:

- tmux server environment had `NO_COLOR=1`: `❯   T r y   " h o w   d o e s ...` (no escape bytes at all)
- tmux started with `env -u NO_COLOR`: `033 [ 3 9 m ❯   033 [ 2 m T r y ...` (dim present, send worked)

`NO_COLOR=1` reached the pane because the tmux server was started from a shell that had it (this agent harness exports `NO_COLOR=1` and `TERM=dumb`). Any user or tool that sets `NO_COLOR` globally hits the same thing. `fleet start` does not clear it: `launch()` in `scripts/watchdog.sh` (around line 136) creates the pane with `tmux new-session`/`new-window` and types `claude ...` into the login shell, so the pane gets the tmux server's global environment, including `NO_COLOR` if the server started with it.

## Impact

- Every `fleet send`, `broadcast` and idle nudge to such a session is refused with exit 4. The refusal is safe (nothing is pasted), but delivery never happens.
- The watchdog's "user is typing, no nudge" path also misfires, so idle agents are never nudged.

## Reproduce (costs nothing if no prompt is sent)

1. `NO_COLOR=1 tmux -L fleet-nocolor -f /dev/null new-session -d -s a -x 120 -y 40 claude` in an empty, trusted folder. Wait for the idle prompt.
2. `tmux -L fleet-nocolor capture-pane -p -e -t a | rg '❯' | tail -1 | od -c` shows no `033 [ 2 m`.
3. Source `watchdog.sh` with `tmux` pointed at that socket and run `input_text a`: prints the suggestion. `user_typing a` succeeds.
4. Clean up: `tmux -L fleet-nocolor kill-server`.

Starting Claude Code costs nothing until a prompt is sent; do not send one.

## Fix options (for the fixing session to choose)

1. **Clear `NO_COLOR` when fleet starts agents** (`fleet start` / tmux `new-session -e NO_COLOR=` or `env -u NO_COLOR`), and document that sessions must not run with it. Simple, but does not cover sessions started by other means.
2. **Detect the suggestion without relying on color**, e.g. recognise the fixed `Try "..."` placeholder form. Brittle across Claude Code versions.
3. **Both**, plus a stub test with a captured `NO_COLOR` prompt line (`tests/` already has capture-based stubs).

Whatever is chosen, add a regression test that fails on the current `input_text` with a no-SGR suggestion line.

## Evidence

- Fleet Control `docs/implementation-status.md`, section "Stage 4 acceptance with a real supervisor".
- Fleet Control `docs/evidence-2026-11-09-supervisor-ack.txt`, events 4-8: `fleet send exit 4: supervisor: text in the input line, not sent`, then `delivered` after tmux was restarted without `NO_COLOR`.
