# Decentralized multi-host client

## Outcome

One Terminal Deck on the MacBook shows independent Fleet Control services on Linux and macOS. Each host retains its own supervisor, existing agent-fleet CLI, SQLite database, command delivery and approval gates. Stopping the MacBook client does not stop host work or answer an approval.

## Chosen boundary

Use a loopback-only client gateway on the MacBook. It serves the existing deck and forwards allowlisted requests to explicitly configured hosts. Per-host tokens stay in local files read by the gateway, never in browser JavaScript. Remote connections require verified HTTPS; HTTP is permitted only for loopback test services.

This adds one local process, but avoids cross-origin browser credentials, CORS changes on every host and exposing host tokens to page scripts. The gateway owns no fleet database, retry queue, supervisor, SSH connection or tmux implementation. Host API/MCP semantics remain authoritative. Existing direct host pages and direct per-host MCP remain available.

## Steps and acceptance

1. **Client gateway.** Configure stable host IDs, service origins and token files. Proxy only supported reads, command submissions, scoped request answers and read-only terminal streams. Reject unknown hosts, unexpected paths, redirects, foreign browser origins and DNS rebinding. Never retry a write automatically. Test two authenticated upstreams with identical session names and different principals; verify no token crosses hosts or reaches browser responses.
2. **Host-scoped deck.** Keep the full-window layout and one host/session navigation. Selecting a host changes its center panes and supervisor panel. Selecting a session changes emphasis. Keep drafts, uncertain command intent and cached state scoped to a host. Disable mutations when current state is unavailable. Verify delayed responses cannot repaint another host's panel or clear its draft.
3. **Failure and runtime proof.** Exercise two independent host services with separate SQLite stores and private shell-only fleets. Read actual terminal tokens through the gateway. Submit a command and answer a request on one host and inspect both stores. Disconnect one service, confirm unknown state there and continued operation on the other. Render desktop and narrow layouts in a real browser.
4. **Installation and handoff.** Document MacBook configuration, per-host MCP registration, macOS launchd and Linux systemd user service examples. Separate code verification from deployment. Record exact test outcomes and remaining platform checks.

## Completion

All four code/documentation stages are complete locally. [Verification evidence](evidence-2026-11-09-multi-host.md) records 161 passing tests, 3 compatibility skips, no failures, actual local fleet tokens, browser interactions and the independent security review. Deployment to Linux/macOS as a pair remains a separately authorized platform check, not a completed acceptance claim.

## Non-goals and permissions

No shared scheduler, replicated host database, automatic failover, cross-host approval, writable terminal, new agent runtime or automatic remote installation. No new dependencies are required.

192.168.50.15 remains on hold and must not be contacted. This change does not authorize deployment to either host, a Tailscale listener, paid runtime agents, credential changes, push or merge. Linux service instructions can be prepared and checked without claiming a live Linux deployment. Two local test services prove isolation, not cross-platform operation.

Later note (2026-11-14): this plan was delivered in PR #3. The hold on `.15` no longer applies: the owner approved the cooperative deployment there on 2026-11-13 (see [deploy-15-plan.md](deploy-15-plan.md)). No host service was installed on `.15`. The paragraph above is the boundary as it stood for this change.
