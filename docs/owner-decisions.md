Pending owner decisions, collected 2026-11-16 (main at e9872be). Each item links to the document that explains it. Nothing listed here has been done; each one needs an explicit answer before work starts.

## 1. Release

The installed services run older code: the host service on `.4` runs `59965a3`, the cooperative central on `.15` and both adapters run `86585c0`. Candidates are rehearsed on loopback only (see "Not yet released" in [implementation-status.md](implementation-status.md)).

- **1a (recommended):** host service only on `.4`, candidate `59bac7b`.
- **1b:** 1a plus cooperative central on `.15` and the adapter on `.4`, candidate `dbb0e3c`.
- **1c:** not yet.

## 2. Waker

Starts an agent when cooperative work is waiting. Needs 1b first (the installed central has no `cooperative_wait`). Question: install it on which host, and does it start Claude Code or DSH?

## 3. Input lease ([input-lease-design.md](input-lease-design.md))

1. Implement live terminal input at all, and on which host first (`fctrl-test` on `.4` suggested)?
2. Writable path: `tmux send-keys` per message (recommended) or a second writable `fleet attach`?
3. May the page principal ever be on the `input` list, or only named tokens?
4. Default and maximum lease length (proposed 5 and 30 minutes)?

## 4. Retention and backups ([host-retention-design.md](host-retention-design.md))

1. Keep only the newest 100 model observations per session? Recommended: yes.
2. File size at which to revisit deleting commands and requests (for example 100 MB)?
3. Where the second backup copy lives (MacBook, `.15`, other). SSH access needs its own approval.
4. A second LaunchAgent on `.4` for a daily backup?

## 5. Stopping commands ([command-stop-design.md](command-stop-design.md))

1. Withdraw queued commands; any operator or only the submitter? Recommended: yes, any operator.
2. Optional `notAfter` that expires a queued command? Recommended: yes, after withdraw.
3. Per-session hold later, together with input leases?
4. Cancelling running work and budgets stay outside Fleet Control for now?

## 6. Service manager ([service-manager-design.md](service-manager-design.md))

1. Keep the LaunchAgent on `.4` with automatic login? Recommended: yes.
2. Enable `autorestart` on `.4` so it comes back after a power cut (host setting)?
3. If `.15` ever gets a host service: `systemd --user` with linger (needs root)?

## 7. Dialog open at delivery ([busy-supervisor-design.md](busy-supervisor-design.md))

1. New status `not_delivered` when `fleet send` provably refused before the paste? Recommended: yes.
2. No automatic retry for it; the operator resubmits? Recommended: yes.

## 8. Frontend ([frontend-choice.md](frontend-choice.md))

1. Stay with plain TypeScript and add a test that every value written into `innerHTML` is escaped? Recommended: yes.

## 9. Subagents ([subagent-mapping-design.md](subagent-mapping-design.md))

1. Keep Agent subagents out of the session list and command targets, visible only through the run record? Recommended: yes.
2. Mirror the worker name, the orchestrator's checks and the review verdict from `run.md` as separate labelled parts of the phase status? Recommended: yes.

## 10. Other open decisions without a proposal yet

From "Open decisions" in [implementation-status.md](implementation-status.md): whether phased-delivery calls `scripts/run-file-sync.ts` at each checkpoint (3), and which real fleet on `.4` the service should serve. Checked 2026-11-16: `.4` has no real fleet yet. The only `fleet.conf` files within five levels of the home directory are the service's test fleet (`~/.local/share/fleet-control/test-fleet/fleet.conf`) and two agent-fleet templates, and no default tmux server runs. So the question is which project gets a fleet first; starting its agents is a real-agent run that needs its own approval.
