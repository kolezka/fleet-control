Status: proposal, 2026-11-16. Nothing here is installed or changed. It answers open decision 2 in [implementation-status.md](implementation-status.md): should a real-fleet host service run as a LaunchAgent (as on `.4` today) or a LaunchDaemon, and what to use on Linux.

## What `.4` does today (read 2026-11-16)

- `~/Library/LaunchAgents/pl.raqz.fleet-control.plist`: `RunAtLoad`, `KeepAlive` with `SuccessfulExit = false` (restarted only after a failure), working directory `~/Development/fleet-control-service`, logs in `~/Library/Logs/fleet-control.log`. Running, one run, never exited.
- Automatic login is set for `me`, so after a reboot the user session starts and the agent with it.
- `pmset`: `sleep 0`, but `autorestart 0`. After a power cut the Mac stays off until someone presses the button. Neither choice below changes that.
- The fleet's tmux servers are sockets under `/tmp/tmux-<uid>/`, owned by `me`. Agents run in them as `me` with `me`'s Claude Code login in `~/.claude`.

## The real difference

The service does not need root. It needs to reach `me`'s tmux sockets, `me`'s fleet config and the agents' login. So the question is not "user or root" but "does it start before or without a login".

| | LaunchAgent (today) | LaunchDaemon with `UserName me` |
| --- | --- | --- |
| Starts | when `me` logs in (automatic login covers reboots) | at boot, no login needed |
| Stops | at logout | only at shutdown |
| Reaches `me`'s tmux | yes | yes, same uid |
| Keychain, GUI session | yes | no (no login keychain; Claude Code may need it for its login) |
| Install | user file, no admin | `/Library/LaunchDaemons`, needs `sudo` |
| Rollback | `launchctl bootout gui/<uid>` | `sudo launchctl bootout system/...` |

The agents themselves run in `me`'s tmux and need `me`'s login anyway. A daemon that starts before login can serve the page but has no agents to deliver to until the fleet is started, and an agent started outside the login session may not reach the keychain. That was not tested.

## Proposal

1. **Keep the LaunchAgent on `.4`**, relying on automatic login. It matches where the agents live and needs no admin rights.
2. **Turn on `autorestart`** (`sudo pmset -a autorestart 1`) so the Mac comes back after a power cut. This is a host setting and needs approval.
3. **Linux (`.15`, if a host service is ever installed there):** `systemd --user` as the installer already writes (`src/install/plan.ts`), plus `loginctl enable-linger me` so it runs without a login. That command needs root and its own approval.
4. Revisit a LaunchDaemon only if the Mac must serve the page while nobody is logged in and the agents are shown to work without the login keychain.

## Questions for the owner

1. Keep the LaunchAgent with automatic login? Recommended: yes.
2. Enable `autorestart` on `.4`?
3. If `.15` ever gets a host service: `systemd --user` with linger?
