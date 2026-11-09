# Multi-host verification, 2026-11-09

## Scope

Local development verification on the MacBook. Two authenticated Bun host services, separate SQLite stores and private shell-only fleet sockets. Both use `probe-shell`; their run ID is `same-run`. No Linux workstation contact, deployment, paid runtime agent or production session was part of these checks.

## Gateway and host contract

- `bun test src/client-gateway.test.ts`: 47 pass, 0 fail. Covers route allowlist, independent credentials, Host/Origin/Sec-Fetch-Site checks, bounded bodies and timeouts, redirect refusal, uncertain write outcomes, read-only WebSocket relay and an actual authenticated host MCP/REST roundtrip.
- `bun test src/gateway-host.test.ts`: 3 pass, 0 fail. Actual host services keep identical command idempotency keys in separate stores. Claimed actors are replaced by each host's authenticated principal. Approving alpha leaves beta's gate closed. A stale beta revision returns 409. Stopping alpha leaves beta readable and does not approve its gate.
- `bun test src/gateway-tls.test.ts`: 1 pass, 0 fail. A fresh self-signed certificate is refused for both HTTP and terminal WebSocket upstreams. A fresh Bun child process explicitly trusting that public certificate returns a decoded session and `TLS-TERMINAL-POSITIVE-CONTROL`. No certificate validation override is used.
- `bun check`: no type errors after correcting the test fixtures.
- `bun run design:check`: exit 0. This remains a minimal-DOM check of historical mockup handlers, not browser or terminal proof.

## Two private runtime fleets

`scripts/dev-two-hosts.ts` started independent loopback host services. Gateway reads returned:

```text
alpha /sessions/probe-shell/screen: HOST-ALPHA-TERMINAL
beta  /sessions/probe-shell/screen: HOST-BETA-TERMINAL
```

The gateway's host descriptor response contained only host ID, display name and same-origin API base. A foreign Origin received 403. No host tokens were printed or included in this record.

## Browser and final gates

- Real browser session `fleet-multi` loaded the gateway and both identically named `probe-shell` sessions. Actual renders were inspected through the vision bridge: desktop retained the selected three-column deck and displayed `HOST-ALPHA-TERMINAL`; switching to beta kept the beta request and terminal scoped to beta.
- Clicking alpha's Approve recorded `response: approve`, `status: resolved`, `resolvedBy: alpha-operator` in alpha. Beta remained `open` with no response. The page explicitly said acknowledgement was still pending.
- Entering `ALPHA-ONLY-DRAFT`, switching to beta and submitting `BETA-ONLY-TEST` left alpha's commands empty and beta's command attributed to `beta-operator`. Switching back restored alpha's draft. Beta's delivery was not claimed as completed; the installed CLI still has the viewer/send limitation below.
- At 600x900, a fresh load had `only-terminal=true`, `aria-expanded=false`, and document scroll width 600. Opening the supervisor overlay and pressing Escape closed it and focused `inspectorToggle`. Both host/session groups remained visible with the overlay closed. Narrow screenshots were inspected, not inferred from CSS.
- Browser network interception blocked only alpha reads (a direct alpha fetch failed as positive control). Alpha became `State unknown`, requests were hidden as current, and Send was disabled. Beta's independent reads returned 200; selecting beta exposed its still-open request and enabled its composer. This browser check simulates a connection failure; the separate actual-host test stops a service.
- Independent security review found the approval page could be framed. A regression test first failed with no `X-Frame-Options`, then passed after serving the page/assets with `DENY` and CSP `frame-ancestors 'none'`. Other reviewed boundaries included token isolation, rebinding, redirects, TLS, bounds and read-only socket teardown. Loopback remains accessible to other local processes/users.
- Final `bun test`: **161 pass, 3 skip, 0 fail**, 1067 assertions across 18 files. `bun check`: no type errors in 41 files. `bun run design:check`: PASS, minimal-DOM historical handler test only. `git diff --check`: clean.

## Limits

These tests do not prove Linux deployment, remote host reboot behavior, production agent compatibility or a fresh cross-platform installation. The existing agent-fleet checkout used here lacks the send-keys fix; its viewer-plus-send regression is skipped unless a compatible checkout is selected. The separate CLI bug is not fixed by the gateway.
