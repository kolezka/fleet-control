# Implementation status and next decisions

Recorded 2026-11-09. This is a source-scoped status report for the local Fleet Control prototype, not an inventory of unrelated services on the machine.

## Existing project files

| File | Current purpose |
| --- | --- |
| `package.json` | Private Bun project; typecheck script; Bun types and TypeScript declarations |
| `index.ts` | Starts the read-only loopback service; requires `FLEET_CONF` |
| `src/fleet/cli.ts` | Adapter over agent-fleet `fleet screen` and `fleet status`, with explicit error kinds |
| `src/fleet/fixture.ts` | Isolated test fleet: private tmux socket, temp FLEET_DIR, one shell session with no model |
| `src/server.ts`, `src/store.ts`, `src/model.ts` | Loopback HTTP API, bun:sqlite session registry, model-state rules |
| `src/*.test.ts`, `src/fleet/*.test.ts` | `bun test` suites (stub fleet plus real CLI on the private socket) |
| `playground.html` | Initial interactive product-direction comparison |
| `console.html` | Earlier terminal-first prototype |
| `.design/drafts/console/terminal-deck/v4.html` | Latest selected coordination mockup |
| `.design/drafts/console/terminal-deck/meta.json` | Selected direction and proposed functionality |
| `.design/design-system.md` | Selected visual tokens and layout constraints |
| `.design/check-coordination.ts` | Focused handler checks using a minimal DOM fixture |
| `.design/shots/` | Saved desktop/phone light/dark renders |
| `docs/HANDOFF.md` | New-session starting point, selected decisions, limits and next action |
| `docs/design/terminal-deck.html` | Byte-identical handoff copy of v4 |
| `docs/design/manifest.json` | Source-linked SHA-256 records for the HTML and preview copies |
| `scripts/check-design.ts` | Portable handler check against the preserved design |
| `AGENTS.md`, `CLAUDE.md` | Entry points that route new coding sessions to the handoff |

The design and documentation pass began without a Git repository. The user subsequently authorized local Git initialization and an initial snapshot on main. Recheck the actual branch, log and working tree when continuing. Remote creation and push were not requested.

## Implemented in the mockup

- Full-window Terminal Deck with distinct host/session hierarchy and no duplicate top session navigation.
- Four synthetic remote roles in a 2x2 pane layout.
- Right-side supervisor request, evidence disclosure, workflow, command history and instruction composer.
- Demo approval and decline, with the next phase still not started while acknowledgement is pending.
- Demo instruction submission, escaped for display and labelled locally queued rather than delivered.
- Preview states for work in progress, disconnection and no output.
- Inspector visibility and terminal text scaling controls.

No live model observation is displayed in v4. The fixtures do not establish that each role has an attachable terminal in the selected runtime.

## Implemented locally: stages 1-2 (2026-11-09, branch `feat-fleet-adapter`)

Scope: MacBook only, private tmux socket, one shell test session with no model. No workstation was contacted, no dependency was installed, no agent was started (`fleet start` launches `claude` and was not used).

- **Stage 1, fleet adapter** (`src/fleet/cli.ts`): wraps agent-fleet 0.3.0 `fleet screen` and `fleet status`; it does not call tmux or SSH itself. Errors are typed: `config`, `session_missing`, `invalid_name`, `cli_failed`, `malformed_output`. Unknown `fleet status` text fails instead of becoming an empty fleet.
- **Finding:** in agent-fleet 0.3.0, `fleet screen <missing>` exits 0 and prints `can't find pane` only on stderr, because capture-pane is piped through awk/tail. The adapter detects it from stderr. A proper exit code belongs in agent-fleet itself.
- **Stage 2, service skeleton** (`src/server.ts`, `src/store.ts`, `src/model.ts`, `index.ts`): `Bun.serve` on `127.0.0.1` only, `GET /api/sessions` and `GET /api/sessions/:name/screen?lines=N`, bun:sqlite registry of known sessions and model observations. Each session carries a model state: `observed`, `configured` (labelled "configured, not observed"), `unknown` (with last observation as history) or `not_applicable` (script session). Observations count as current only for the same runtime instance and within 10 minutes. The fleet CLI exposes no runtime instance yet, so every agent currently shows `unknown` or `configured`. No observation collector exists.
- Run: `FLEET_CONF=/path/fleet.conf bun run serve`. No auth, so it must stay on loopback.

Verification (2026-11-09, this worktree): `bun test` 26 pass / 0 fail, including real-CLI tests that read known tokens from the test session, get explicit errors for a missing session and a broken or absent `fleet.conf`, and confirm the session is still alive after reads. Negative control: removing the missing-pane check makes the missing-session test fail. `bun check` clean. `bun run design:check` still passes.

This is not a workstation integration, terminal bridge or production test. The tests ran on the Mac against a shell session, not an agent.

## Implemented locally: stage 3, read-only terminal (2026-11-09, same branch)

Scope: MacBook only, private test fleet, shell session with no model. Hosts `.15` and `.4` were not contacted for this stage (user: leave `.15` alone for now).

- **agent-fleet change** (separate repo, worktree `~/Development/agent-fleet.worktrees/attach-read-only`, branch `feat/attach-read-only`, commits `2bb3678`, `a13b386`, `957467e`; merged to agent-fleet `main` as `8a1bd2c` via kolezka/agent-fleet#6 on 2026-11-09. The plugin version is still 0.3.0, so installed plugin caches do not contain it): `fleet attach --read-only <session>` runs `tmux attach -f read-only,ignore-size`. Finding: `ignore-size` does not stop a *sole* client from sizing the window, so for local read-only attach the script first sets its own tty to the agent window size (plus status line) and announces it as `OSC 777;fleet-size;W;H`. Remote (`REMOTE_SSH`) attach gets the flags but not the sizing; untested.
- **Viewer** (`src/terminal/viewer.ts`): Bun PTY running `fleet attach --read-only`. Refuses a CLI without that flag instead of attaching writable. No write or resize path.
- **WebSocket** `GET /api/sessions/:name/terminal`: same-origin only (403 otherwise). Any client message, typing or resize, closes the socket with 1008. Closing the socket sends SIGHUP to the viewer; the session keeps running.
- **Page** (`web/index.html`, `web/app.ts`, `web/deck.css` copied from the baseline, `web/live.css`) served at `/`: host-grouped left nav from `/api/sessions` with model label per session, one ghostty-web 0.4.0 pane per running session created at the announced agent size and scaled to fit, supervisor panel saying no supervisor is connected. `ghostty-web` pinned at 0.4.0 (MIT, no dependencies) with approval.
- ghostty-web 0.4.0 throws `RangeError: offset is out of bounds` on an empty `write("")`; the page skips empty writes.
- Local demo: `READONLY_FLEET_BIN=~/Development/agent-fleet.worktrees/attach-read-only/scripts/fleet bun scripts/dev-test-fleet.ts`.

Verification (2026-11-09): `bun test` 33 pass / 0 fail. New real-tmux tests: viewer streams the known tokens, the tmux client is `read-only` + `ignore-size`, agent window stays 120x30 with a 40x10 viewer, closing leaves no client and a live session; missing session exits non-zero; WebSocket: a resize message plus `echo FCINJECT\r` closes with 1008, `FCINJECT` never reaches the pane, window stays 120x30; cross-origin upgrade gets 403 and starts no viewer. agent-fleet stub test: failures 0. Manual check in Chrome (agent-browser), 1440x900, dark and light: tokens and tmux status line render inside the pane; while the page was open tmux listed one client `read-only,ignore-size` at 120x31 and the window stayed 120x30; typing in the page did not reach the pane; closing the browser left 0 clients.

Not covered: agent (`claude`) sessions, remote hosts, several viewers at once, reconnect, auth, the 600px layout, and an accessibility check. Supervisor panel, commands and model collection are still not connected.

## Implemented locally: stage 4, durable commands and MCP (2026-11-09, same branch)

Scope: MacBook only, loopback service, private test fleet with a shell session. No agent (`claude`) session, no supervisor and no remote host took part. User chose the official MCP SDK; `@modelcontextprotocol/sdk` 1.32.2 (MIT) and `zod` 4.6.7 pinned in this worktree.

- **Queue** (`src/commands.ts`): SQLite tables `commands` and `command_events` in the service database. Statuses `queued`, `delivering`, `delivered`, `delivery_unknown`, `accepted`, `rejected`, `running`, `completed`, `failed`, with a fixed transition table. Every change appends an event with actor and detail. Same idempotency key with the same intent returns the original command; with a different intent it is a conflict. On start, a command left in `delivering` becomes `delivery_unknown` (it may have reached the pane), never `queued`.
- **Delivery** (`src/delivery.ts`): existing `fleet send`, one delivery at a time. The pasted message starts with `Fleet Control command <id> from <actor>:` and says delivery is not approval. Exit 0 with `delivered` is `delivered`. Refusals before any paste (`not sent`, `no session`) leave it `queued`. Anything else, including a crash of the sender, is `delivery_unknown` and is not retried automatically.
- **Acceptance and execution are explicit**: `delivered` only means the first line appeared in the pane. Only `command_respond` (accepted/rejected) and `command_report` (running/completed/failed with evidence) move it further. Completion before acceptance is refused.
- **MCP** `POST /mcp` (Streamable HTTP, stateless, JSON responses): tools `command_submit`, `command_deliver` (retry a queued one), `command_get`, `command_list`, `command_events` (cursor), `command_respond`, `command_report`. DNS rebinding protection admits only `127.0.0.1:<port>` and `localhost:<port>` Host headers; a browser Origin from elsewhere gets 403.
- **REST** for the web UI, same queue: `GET/POST /api/commands`, `GET /api/commands/:id`. POST is same-origin only; 400 bad input or JSON, 409 key conflict, 404 unknown id. The page does not use it yet.
- `index.ts` and `scripts/dev-test-fleet.ts` wire the queue; `FLEET_CONTROL_DB` keeps it across restarts.

Verification (2026-11-09): `bun test` 51 pass / 0 fail, `bun check` clean. Real `fleet send` against the private test session: command id appears in the pane and status is `delivered`; missing session stays `queued` with `no session ...`; dialog-like text stays `queued` with `not sent`. MCP SDK client against the real server: tool list, submit → delivered, retry with the same key does not paste twice, report before accept refused, accept → completed, REST and MCP see the same command, foreign Host and Origin 403. Negative controls: disabling the intent check fails the conflict test; reconciling to `queued` fails the restart test. End to end with the service process and `curl` (no SDK): command delivered into the tmux pane; after SIGTERM and restart on the same database the command is still listed and the same key returns `created: false`; no test sockets left.

Not covered: a real supervisor reading and answering through MCP (needs a paid `claude` session, not authorized), a Claude Code client registering `/mcp`, auth (anyone local can call it), several hosts, the page using the queue, event streaming (polling only), scoped approvals (stage 5).

### Stage 4 acceptance with a real supervisor (2026-11-09, paid, approved by the user)

One Claude Code 2.1.319 session (`--model haiku`, Haiku 5.5) on a private tmux socket `fleet-fcsuptest` on the MacBook, started by `scripts/supervisor-test/run-supervisor.sh`: no user/project settings or plugins (`--setting-sources ""`), only the Fleet Control MCP server (`--strict-mcp-config`), no built-in tools (`--tools ""`), `--permission-mode dontAsk` with only `command_get`, `command_respond` and `command_report` allowed. Its instructions are in `scripts/supervisor-test/prompt.txt`. Commands were submitted by `curl` to `/mcp` as `macbook-test`. Cost reported by `/cost`: $0.0029.

Result, read from the service database (`docs/evidence-2026-11-09-supervisor-ack.txt`), not from the agent's text:

- "Compute 17 * 23": `queued` → `delivering` → `queued` (fleet send exit 4, see below) → retried with `command_deliver` → `delivered` → `accepted` by `test-supervisor` → `completed` with evidence `17 * 23 = 391`.
- "Delete the file .../prompt.txt": `delivered` → `rejected` by `test-supervisor` ("Requires file deletion..."). The file was still there afterwards.
- An earlier command stayed `delivered` forever because the session was not logged in (it printed "Login expired"). Delivery was confirmed, but nobody accepted it. This is the case the separate states exist for.

Findings:

- `--setting-sources ""` also drops the `env` block of `~/.claude/settings.json`, which holds this machine's gateway auth. The launcher copies only `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` from it. The values are not stored in the repo.
- When the tmux server inherits `NO_COLOR=1` (this harness sets it), Claude Code draws its placeholder suggestion without the dim attribute. agent-fleet's `user_typing` then reads the suggestion as typed text and `fleet send` refuses with exit 4. The queue handled it correctly (back to `queued`, safe retry). Starting tmux without `NO_COLOR` fixed it. This is an agent-fleet detection gap to report there; not changed in this session.
- Workspace trust for the new empty folder had to be accepted once by hand.

Not covered: a supervisor doing real work with shell or file tools, a long-running or busy supervisor, commands arriving while a dialog is open, Opus or Sonnet supervisors, remote hosts.

## Implemented locally: stage 5, scoped requests and the page panel (2026-11-09, same branch, tested on 192.168.50.4)

- `src/requests.ts`: `Requests` with tables `runs`, `requests`, `request_events`. A run has one orchestrator, the only actor allowed to write its phase record (`registerRun`, `updatePhase` with `expectedRevision`). A request is bound to run, phase and revision. A new revision, or a phase change, makes every open request stale. `resolve` needs the request's revision and an allowed response; a second, different answer is a visible conflict and the first stands; the identical answer retried is fine. `acknowledge` (orchestrator only) records that the answer was read, not that the next phase started. `gate(run, phase, revision)` is true only for an `approve` on exactly that phase and revision; a decline wins; no answer is "approval requested, no answer yet".
- MCP tools: `run_register`, `phase_update`, `request_create`, `request_resolve` (only to relay a real human answer), `request_acknowledge`, `request_withdraw`, `request_list`, `request_gate`, `request_events`. REST: `GET /api/requests`, `POST /api/requests/:id/resolve` (same Origin header required, actor `web-ui`). Actor names are self-declared until stage 6 adds auth.
- Page (`web/index.html`, `web/app.ts`): the right panel now shows the live request (question, proposed action, phase, revision, evidence, allowed answers), the workflow row from the phase record, the last commands with their honest state ("Delivered, not acknowledged", "Delivery unknown", ...), and the instruction field posting to `/api/commands`. The instruction goes to the run's orchestrator session if it is running, else to the selected session, and the target is shown before sending. A retry after a network error reuses the idempotency key. Polls every 3 s.
- Tests: `src/requests.test.ts` (15), `src/requests.api.test.ts` (5: MCP ask, REST answer, gate; MacBook-vs-page conflict; stale revision, foreign or missing Origin; worker cannot write phase). Full suite on `.4` (private checkout `~/Development/fleet-control-dev`, private tmux sockets, loopback only): 71 pass, 0 fail; `bun check` clean; `design:check` PASS. Negative controls: removing staling, the conflict check, the revision check in `gate`, or the Origin-required check each make one test fail.
- Browser check on `.4`'s service through an SSH tunnel (Chrome via agent-browser, 1440x900, dark): request, workflow, commands and composer render in the baseline layout; Approve in the page recorded `approve` by `web-ui` for revision 1 and showed "Answered, awaiting acknowledgement"; the instruction reached the pane text.

Finding, not fixed: with the read-only viewer attached, `tmux send-keys` is refused with `client is read-only`, so `fleet send` pasted the instruction but could not press Enter (exit 7). The command was recorded as `delivery_unknown`, which is correct. This also blocks every watchdog `send-keys` while a viewer is open. Write-up and repro: [bugs/agent-fleet-send-keys-read-only-viewer.md](bugs/agent-fleet-send-keys-read-only-viewer.md). The viewer must not be used with real agent sessions until this is fixed.

Not covered: a real orchestrator using the request tools, phased-delivery writing its phase record through `phase_update`, multiple runs in the panel, push updates instead of polling, 600px layout, accessibility review, HIG review through Docify.

## Implemented locally: session 3 (2026-11-09, same branch)

- **Model per session** (`src/observe/claude.ts`, commit `2c51ec9`): for each fleet session the service finds the `claude` child of the tmux pane, checks `~/.claude/sessions/<pid>.json` against the process start time, and reads the last main-thread assistant model from the session transcript. Subagent (`isSidechain`) and `<synthetic>` turns never overwrite it. The page shows observed / configured / unknown (with reason) / no model for scripts, with source and turn time in the tooltip, and refreshes labels every 15 s without reopening terminals. Checked against two live Claude Code 2.1.319 processes on the MacBook (both `claude-opus-5-5`); not yet against an agent started by agent-fleet. Details and freshness policy: [model-observability.md](model-observability.md).
- **Auth and bind** (`src/auth.ts`, `src/config.ts`, commits `822346d`, `a54ad9e`): bearer tokens per principal, hashed in a tokens file; the principal is the recorded actor for commands, answers and phase writes and replaces any actor a client claims, so a worker token cannot write the orchestrator's phase record. Browser sign-in at `/login` trades the token for an HttpOnly SameSite=Strict cookie. Any bind other than loopback without `FLEET_CONTROL_TOKENS` refuses to start. Optional TLS. Configuration and a draft launchd plist for `.4`: [installation.md](installation.md).
- **Page** (commit `3c863f4`): terminals reconnect with backoff (1, 2, 5, 10, 30 s) and redraw from a fresh attach; a refused or normally ended viewer is not retried. `/api/hosts` names this host; peers from `FLEET_CONTROL_PEERS` are listed in the nav as links to their own services (not proxied). Below 901 px the supervisor panel starts closed and Escape closes it. At 600 px the terminal keeps the agent's size and scrolls sideways.
- Accessibility pass against `apple-his@1.0.0` Accessibility > Vision (`p_c0fddc877c056647381b`) and > Mobility (`p_f312d5102c67a3d27304`), measured in Chrome on the live page: all visible text at least 10 px (macOS minimum 10 pt); muted text on the selected tint was 4.38:1 in light mode and is now at least 4.64:1 (dark at least 5.76:1); every control has an accessible name; the history disclosure was raised to 24 px tall; focus rings added where missing. Not a full HIG review: no VoiceOver run, no 200 % text test, no reduced-motion or keyboard-only walkthrough.
- Tests: 96 pass, 0 fail on the MacBook and on `.4`; `bun check` clean; `design:check` PASS. Negative controls: removing the sidechain filter, the principal override, or the auth guard each make tests fail. On `.4` (loopback, private socket): no token 401, bearer 200, posted command recorded actor `mini-test` although it claimed `orchestrator`, `/mcp` without token 401, bind `0.0.0.0` without tokens refused. Reconnect checked in a browser by restarting the service under an open page.

## Not implemented in this project

- Persistent installation on a host, LAN/Tailscale exposure, and MCP used from the MacBook against a remote host. The code supports it; nothing is installed (needs the owner's approval).
- Using the viewer with real agent sessions: blocked by the agent-fleet `send-keys` bug ([bugs/agent-fleet-send-keys-read-only-viewer.md](bugs/agent-fleet-send-keys-read-only-viewer.md)), handed to a separate agent-fleet session.
- phased-delivery writing its phase record and requests through the MCP tools; a real orchestrator using them.
- Terminal input and exclusive input leases. The viewer is read-only by design.
- Push event stream (the page polls every 3 s for requests and commands, 15 s for sessions).
- Model observers for harnesses other than Claude Code, and for remote (`REMOTE_SSH`) fleets, which each host's own service should observe.
- Supervisor replacement, reboot recovery of in-flight commands beyond `delivering` → `delivery_unknown`, event retention and backups.
- Token rotation tooling beyond editing the tokens file; per-principal permissions (every principal can do everything except write another orchestrator's phase).

The mockup's send button writes only browser memory. The live page (`web/`) posts to the service.

## Verification evidence

During design iteration, the installed design-studio renderer produced desktop 1440x900 and phone 390x844 screenshots in light and dark. The contact sheets were opened and reviewed. After the composer initially extended below the visible panel, the right sidebar was changed so the composer remains outside the scrollable request/history area, then rendered again. These observations are visual review, not a full browser interaction or accessibility test.

During this documentation save, the existing check was rerun:

```bash
bun .design/check-coordination.ts
```

Exit code: 0. It reported checks for the initial fixture, blank input, escaped instruction text, locally queued receipt, approval awaiting acknowledgement, no automatic next-phase start, decline and disconnected refusal.

That script executes the actual draft handlers against a minimal DOM fixture. It does not run Chrome, a real supervisor, a network transport or an actual PTY. Its green result must not be called production verification. The current fixture checks also do not demonstrate restart recovery or malformed persistent-record handling.

## Source checks behind the documentation

The documentation save reread the local package, entry point, selected draft metadata, v4 interaction code and design notes.

Installed integration source checked:

- agent-fleet 0.3.0, `scripts/fleet`, lines 288-373: start, send, fleet-wide decide, human-readable status, screen, watchdog, attach and monitor command.
- phased-delivery 0.2.0, `skills/phased-delivery/SKILL.md`: worktree setup, persistent worker, independent verification, fresh review, phase gates and stop conditions.
- phased-delivery 0.2.0, `README.md`: package contents, Agent-based workers/reviewers and file-based run state.

Those are source checks of installed packages, not a live fleet probe. Do not generalize their interfaces to an uninspected future release.

The HIG passages cited in [interface design](ui-design.md) were read through Docify. The source version and passage IDs are included there.

## Decided

- Hosts: `192.168.50.4` (macOS, user `me`) and `192.168.50.15` (Manjaro, user `me` via `REMOTE_USER`, on hold). Peers, each with its own service; access over LAN and Tailscale.
- Store: SQLite per host (`bun:sqlite`). Client auth: bearer tokens per principal, browser cookie. PTY: Bun built-in terminal with `fleet attach --read-only`; renderer `ghostty-web` 0.4.0. MCP: official SDK, Streamable HTTP at `/mcp`.
- Model source for Claude Code: session file plus transcript, bound to pid, session id and process start.

## Open decisions

1. Network route to the service. Owner decision 2026-11-09: no listener on Tailscale. Remaining options: loopback plus an SSH tunnel from the MacBook, or a LAN bind (needs TLS or acceptance of clear-text tokens on the LAN).
2. LaunchAgent vs LaunchDaemon on `.4`; when `.15` comes off hold, a systemd user unit there.
3. Machine-readable phase format in phased-delivery and how it syncs with `run.md` without two writers.
4. Supervisor wakeup when it is busy or a dialog is open; what a command does then.
5. Mapping Agent subagents to reports rather than terminals.
6. Input leases: who may type, for how long, and how that coexists with the watchdog.
7. Retention, backups and restore tests for the SQLite file.
8. Budgets, stop time, pause/cancel semantics and standing permissions.
9. Frontend: stay with plain TypeScript and the deck CSS, or adopt a framework when the page grows.

## Suggested next order

1. Verify the agent-fleet `send-keys` fix from Fleet Control once it lands (page open, `fleet send` returns `delivered`).
2. With approval and a chosen network route (not Tailscale): install the service on `.4` (launchd, tokens), register MCP from the MacBook, then disconnect the MacBook and confirm state, approvals and queued commands survive.
3. phased-delivery writes its phase record and requests through MCP; one real run on a test repository.
4. Input lease design, then implementation.
5. `.15` when the hold is lifted.
