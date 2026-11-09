# agent-fleet: send-keys fails while a read-only viewer is attached

Status: open. Found 2026-11-09 on 192.168.50.4 (macOS, tmux 3.8) during the Fleet Control stage 5 browser check.

## Symptom

With the Fleet Control page open, an instruction sent from the page ended as `delivery_unknown`:

```
fleet send exit 7: client is read-only
probe-shell: pasted, but tmux could not press Enter
```

The text reached the pane (paste worked) but Enter was never pressed.

## Cause

When `tmux send-keys` runs outside tmux, tmux picks a client attached to the target session. If that client was attached with `-f read-only` (what `fleet attach --read-only` does), the command is refused with `client is read-only`. `paste-buffer` is not affected.

Minimal repro (private socket, no fleet involved):

```bash
S=fcrepro; tmux -L $S -f /dev/null new -d -s t -x 80 -y 20 cat
tmux -L $S new -d -s holder "TMUX= tmux -L $S attach -f read-only,ignore-size -t t"
sleep 1
tmux -L $S send-keys -t t Enter          # client is read-only, exit 1
printf '\r' | tmux -L $S load-buffer -b cr - && tmux -L $S paste-buffer -d -b cr -t t   # exit 0
tmux -L $S kill-server
```

Observed variations:

- Targeting by pane id (`-t %0`) or window (`-t t:`) fails the same way.
- A control-mode read-only client (`tmux -C attach -f read-only`) fails the same way.
- A viewer on a grouped session (`new-session -t t -s t-view`, then read-only attach) still fails.
- With a writable client attached as well, `send-keys` succeeded in one run. Do not rely on that.

## Impact

Every `tmux send-keys` in `scripts/watchdog.sh` is affected while a viewer is attached: `paste_file` Enter (line 110), the idle nudge (122), the stuck-agent Escape and message (127-129), dialog handling (59-60), context handoff (188), the disk warning (243). So opening the Fleet Control page can silently stop the watchdog from nudging or unsticking an agent. `fleet send` at least reports it (exit 7).

Fleet Control reports this honestly (`delivery_unknown`), but it must be fixed before the viewer is used with real agent sessions.

## Fix options (for agent-fleet)

1. Send keys without going through a client: replace `send-keys Enter` with a pasted `\r` (`load-buffer` + `paste-buffer` without `-p`). Works in the repro. Needs checking against Claude Code: a bare CR outside bracketed paste must submit, and Escape/C-u have to be handled the same way (`\033`, `\025`).
2. Check whether tmux treats this as a bug (send-keys from a command line with no client should not inherit a read-only flag) and report it upstream. Keep option 1 regardless, since older tmux stays installed.
3. Fleet Control side: stream with `capture-pane` polling or `pipe-pane` instead of attaching a client. Loses the exact live rendering; only worth it if 1 fails.

Regression test: attach a read-only client in `tests/socket-and-attach-stub.sh` (or a real tmux test), then assert `paste_file` returns 0 and the pane received Enter.

## Status (2026-11-09 15:20)

A fix exists, not yet committed: the agent-fleet session's worktree `~/Development/agent-fleet.worktrees/paste-keys-ro` (branch `fix/paste-keys-read-only`) replaces every `send-keys` in `scripts/watchdog.sh` with `keys()`, which pastes raw bytes from a buffer (`paste-buffer -S` where tmux has it). Its own tests pass, including the new check 8 in `scripts/test-local.sh` (viewer attached, `send-keys` refused, `fleet send` still presses Enter, Escape / C-u / 2 / Enter arrive as `1b 15 32 0d`).

Fleet Control regression test: `src/terminal/viewer-send.test.ts`. It opens the real read-only viewer, confirms `send-keys` is refused, then delivers a command through `Deliverer` and expects `delivered` plus Enter in the pane. Against a copy of the fix: pass. Against agent-fleet `main`: `delivery_unknown`, fail. It skips itself when `READONLY_FLEET_BIN` predates the fix.

Not yet checked: a real Claude Code agent receiving Enter as a pasted `\r` with the page open.
