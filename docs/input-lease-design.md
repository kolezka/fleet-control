# Terminal input lease: design

Status: implemented on branch `feat/input-lease` (2026-11-20), off by default (`FLEET_CONTROL_INPUT=1`). The owner authorized terminal input in the Portainer-style GUI goal. Three choices differ from this design, each for a stated reason: keys are pasted with `tmux load-buffer` + `paste-buffer -d`, not `send-keys`, because tmux refuses `send-keys` with "client is read-only" while the page's viewer is attached (measured on tmux 3.8 and 3.7c); `-S` is added where tmux lists it, because newer tmux otherwise escapes control bytes in a paste (`vis(3)`), so Ctrl-C would arrive as text; the allowlist is the `operator` role (new `input` permission) instead of a separate `input` file, because roles arrived after this design; the lease is 5 minutes by default, 30 at most, as proposed. The instance is the session's tmux id and creation time plus the pid of its active pane (see below), and held commands show as plain "queued", not "waiting: input lease active". The sections below are the original design; where they differ, this paragraph and the implementation status win. See [implementation status](implementation-status.md#terminal-input-lease-2026-11-20-branch-featinput-lease-not-released).

## Why

The page's terminal is read-only: `fleet attach --read-only` on the host, and the WebSocket closes with 1008 on any client message (`src/server.ts`, `websocket.message`). Instructions go through the command queue and `fleet send`, which pastes a whole message and presses Enter. Some situations need keystrokes instead: a permission dialog, a menu, Ctrl-C on a stuck tool. `docs/control-protocol.md` asks for writing to need "a separately authorized, exclusive input lease bound to the session instance", with no silent grant from a phase approval and no stale ownership restored on reconnect.

## What a lease is

One row per tmux session in the host service's SQLite state:

| field | meaning |
| --- | --- |
| `session` | fleet session name |
| `instance` | session instance at grant time (below) |
| `holder` | principal name from the token file |
| `socket_id` | the one WebSocket allowed to write; random, server side |
| `granted_at`, `expires_at` | absolute times; default length 5 minutes, at most 30 |
| `revoked_at`, `reason` | set once, never cleared |

Rules:

- At most one active lease per session (unique partial index on `session` where not revoked and not expired).
- The session instance is `#{session_id}:#{session_created}` plus the pane pid from the fleet's private tmux socket. Implemented: one `tmux list-sessions` call gives the active pane's pid. agent-fleet restarts an agent in a new window, so its pane pid changes. A child process of the pane's shell is not used: a command typed into a shell pane would change it and end the holder's own lease (review 2), and a background child would hide a restart. An agent restarted by hand in the same pane keeps the lease; that is a known limit. An agent that exits does end it: the same call reports `pane_current_command`, and a pane that ran something else at grant and now runs a shell ends the lease, so keys never fall through to the shell (review 3). The probe on tmux 3.8 printed `$0 1794799338` and `%0 20800`. `session_id` alone restarts at `$0` with every tmux server, so it is never used alone. If the instance differs from the lease's, the lease is dead: a restarted agent never inherits it.
- The lease belongs to one WebSocket, not to the principal. A reconnect, a second tab or the same principal on another device gets a read-only view. Getting input back means asking again. This is the "no stale ownership on reconnect" rule.
- Closing the socket, expiry, an instance change, `fleet` stopping the session or a revoke ends the lease at once. No grace period.
- Superseded: the `operator` role has the `input` permission instead. Original: only principals listed in a new `input` file (one name per line, next to the token file) may hold a lease. Today every token can do everything; input is the first permission that is not given to every token. The file starts empty, so no principal can hold a lease until the owner adds one.
- A phase approval, a resolved request or a queued command never creates a lease.

## Flow

1. The page shows "Request input" on the terminal pane. It sends `POST /api/sessions/:name/lease` with the current WebSocket's id and a reason. Same Origin required, as for other writes.
2. The service checks the principal is in `input`, reads the instance, and inserts the row in one transaction. It returns 409 if another lease is active, naming the holder and expiry.
3. The service opens a second, writable tmux client for that socket only (`fleet attach` without `--read-only`, or `tmux send-keys -l` per message; see open questions). The read-only viewer stays as the output path.
4. Client messages on that WebSocket are now accepted as input. Each message is at most 4 KiB. Every message is recorded in an append-only `lease_events` table with its byte count and SHA-256, not its content, because input can contain secrets.
5. `DELETE /api/sessions/:name/lease` releases it. Any principal in `input` can revoke someone else's lease, with a reason that is recorded.

On any refusal or end the socket falls back to read-only and the page says why ("lease expired", "agent restarted", "revoked by …").

## Interaction with `fleet send` and the watchdog

`fleet send` pastes and presses Enter. If a human is typing half a line, a paste lands in the middle of it. While a lease is active, the delivery worker should hold queued commands for that session and show "waiting: input lease active" instead of pasting. A command that already started delivering still ends as `delivered` or `delivery_unknown` as today. The watchdog's own Enter presses are agent-fleet's concern; the lease does not stop them, and the page should say so.

## What it does not do

- No shared or multi-writer input, no lease queue.
- No recording of what was typed. Only counts and hashes.
- No input on central or through the cooperative adapter. Leases are local to the host service that owns the tmux socket. The client gateway would forward the two lease routes like other host routes.

## Open questions for the owner

1. Authorization to implement live input at all, and on which host first. A test fleet such as `fctrl-test` on `.4` is the natural first target.
2. Writable path: a second writable `fleet attach` client (full key fidelity, but tmux then sizes the window to the smallest client) or `tmux send-keys` per message (no resize problem, but escape sequences must be translated). The second is simpler to bound and test.
3. Whether the page principal may ever be on the `input` list, or only named tokens.
4. Default and maximum lease length.

## Tests the implementation would need

- Unit: one active lease per session, expiry, instance change kills the lease, reconnect does not inherit it, a non-listed principal gets 403, phase approval creates no lease.
- Integration on a private tmux socket: keys arrive only from the lease holder's socket, a second socket's messages close it with 1008, `fleet send` is held while a lease is active, closing the socket ends the lease within one second.
- No test with a real agent until the owner approves one.
