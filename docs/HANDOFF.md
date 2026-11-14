# Fleet Control session handoff

Prepared 2026-11-09. Project: `/Users/me/Development/fleet-control`. This is a separate project from ai-docify, where the originating conversation happened to start.

## Start here

1. Read this file and [docs index](README.md).
2. Open [the selected design](design/terminal-deck.html). It is self-contained and does not depend on a running preview server.
3. Read [architecture](architecture.md), [control protocol](control-protocol.md) and [installation split](installation.md).
4. Read [UI design](ui-design.md), the [visual tokens](../.design/design-system.md) and [model visibility requirement](model-observability.md).
5. Check [implementation status](implementation-status.md) before claiming anything works outside the mockup.

Do not restart product discovery or redesign the agreed layout without a new reason. The host service is implemented and the macOS test deployment is recorded below. The latest work is the central server section below. [The decentralized-client plan](decentralized-client-plan.md) was delivered in PR #3.

## Latest: central server and cooperative supervisor (in progress)

Updated 2026-11-13.

**Where the code is.** All central work is on `main`. The owner authorized merging. [PR #6](https://github.com/kolezka/fleet-control/pull/6) (cooperative central and adapter) merged as `a73b324`. Follow-ups: #7 checks the central credentials file before any SQL, #8 drains legacy central requests on shutdown, and #9 closes idle host sockets when stopping begins. PR #5 was closed as superseded because #6 contains its outbox. Check `origin/main` before continuing rather than relying on a recorded commit. Read [central server status](central-server-status.md) before claiming anything works.

**Goal.** A central Bun/Hono/PostgreSQL server holds control state (commands, approvals, supervisor identities); hosts keep execution. The owner subsequently approved a narrow local Terminal Deck command-panel integration with cooperative central; the layout stays unchanged. The opt-in gateway uses a separate operator credential and explicit host/session mapping, bounded history and inspection, with approvals and workflow labeled unavailable. See [multi-host configuration](multi-host.md#optional-cooperative-central-commands). This slice is local only, not a deployment. No remote host access or deployment without separate authorization. Hono and a local PostgreSQL test container are authorized dependencies.

**Installation CLI slice.** The owner requested a PR for fresh central, adapter and client installation from a prepared local or SSH checkout. See [installation CLI](install-cli.md). This is not permission to apply it to the existing deployments. Preserve explicit plan/apply, existing-state refusal and separately provisioned adapter credentials. No update, restore, code transfer, dependency bootstrap or implicit reactivation of an existing supervisor.

**Decisions to keep.**

- Delivery is cooperative: the supervisor model calls MCP `cooperative_claim` and `cooperative_report` itself, because `fleet send` resolves the tmux pane by name repeatedly and cannot be bound to one runtime instance (see `vendor/agent-fleet/scripts/watchdog.sh`). There is no tmux paste fallback and no wakeup of an idle agent. The owner chose this.
- Each supervisor process gets an incarnation credential. Activation revokes the previous incarnation for that host and session. Claims and reports lock slot, identity and incarnation in the same PostgreSQL transaction. Fencing cannot cancel external effects that already started.
- A claim is a reservation, not acceptance or execution. The command row stays `claimed`; progress lives in `central_cooperative_lifecycle_events`. Unknown outcomes are never retried automatically.
- In cooperative mode, legacy supervisor MCP reads and writes must stay off: they expose command text to stale processes and are not incarnation-fenced.
- Never activate a supervisor implicitly on a server that reuses a schema. `cooperative-main.ts` does it only because every start provisions a fresh schema. The persistent `cooperative-service.ts serve` opens the existing installation without rotating incarnations; `activate` is an explicit administrative action for the selected host and session.
- No restore script: check-then-`pg_restore` cannot be made safe. `scripts/central-backup.ts` is an unverified dump; `scripts/central-backup-check.ts` only checks that its table of contents is readable. One manual restore rehearsal into a throwaway database matched row counts and checksums; see central-server-status.md.

**Disposable test entry point (historical local synthetic evidence).** `bun src/central/cooperative-main.ts` requires `COOPERATIVE_DATABASE_URL` for trusted provisioning and `COOPERATIVE_RUNTIME_DATABASE_URL` for a pre-created restricted login named `cooperative_runtime_<32 hex>` on the same disposable database. It also requires `COOPERATIVE_SCHEMA=cooperative_test_<32 hex>`, `COOPERATIVE_CREDENTIALS_FILE` (absolute path to a private 0600 file you own, not a symlink; one supervisor, at least one operator) and `COOPERATIVE_INCARNATION_FILE` (absolute path that must not exist; written once with mode 0600, never printed). Its process test covers operator submission, claims, reports, inspection and incarnation replacement. After merging PR #9, 1289 tests passed across 178 files with the disposable PostgreSQL fixture, excluding the 7 files that start real tmux sessions or the fleet CLI; do not run those without separate authorization. The runtime role fixture is test-only and does not establish a production provisioning procedure.

**Test database on a new machine.** PostgreSQL tests skip without `CENTRAL_TEST_DATABASE_URL`, and a skip is not a pass. Many tests use that URL without checking its destination and create and drop schemas. Before running them, verify that the effective connection reaches the intended disposable database; a loopback address or database name alone does not prove its identity. Bun SQL can use environment settings such as `PGDATABASE` in preference to the URL database name. Check the effective environment, including variables loaded from `.env`, before connecting. `cooperative-main.ts` restricts its configured URL to `127.0.0.1:57507/fleet_control_test`, but that check does not constrain every environment override or prove what is listening there. Create a disposable database:

```bash
git submodule update --init --recursive
bun install
docker run -d --name fleet-control-central-test -p 127.0.0.1:57507:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=fleet_control_test postgres:17
# Run only explicitly reviewed test files. The full suite includes fleet and tmux tests.
```

Trust auth is acceptable only because the port binds to loopback and the data is disposable. If Docker reports SQLSTATE 53100 `No space left on device`, the Docker VM disk is full, not the host disk.

**Progress and remaining work, in priority order.**

Deployment target chosen by the owner: `.15`. The persistent cooperative central and PostgreSQL are deployed on host loopback; see [deploy-15-plan.md](deploy-15-plan.md). The earlier disk-full blocker was cleared. On 2026-11-13 the owner approved Tailscale Serve and persistent adapters on both fleet hosts (`.4` and `.15`); that rollout passed synthetic lifecycle and restart checks on both hosts (PR #58). Central is reachable inside the tailnet at `https://local-arch.tail4a51cb.ts.net:4881`; each adapter remains on its host loopback port 4882 with a separate supervisor identity. A subsequent lead-verified real DSH run on `.15` used the persistent desktop adapter and tailnet central: command `cmd-2e328ebb-bbc1-411c-8f8c-136a5681ef65` reported accepted/running/completed on the active incarnation with exact fixture answer `2: host-b, host-d`, unchanged file, exit 0, final status completed and no token leak (about 13 seconds). DSH `0.2.2-rc.1` used isolated Node `24.22.3` and CLIProxyAPI in private `/mnt/data/fleet-control-smoke`; the system runtime was unchanged. The agent was read-only with shell, write, search, subagents and web disabled. The lead removed temporary proxy-key and run-patch copies afterward. No production `tv-*` sessions were touched; UI integration and agent-fleet idle wakeup remain unverified. See [run evidence](central-server-status.md#real-dsh-on-15-2026-11-13). Other remote work still needs its own authorization.

1. Done locally: `src/host-agent/cooperative-main.ts` runs the adapter and listener as a disposable loopback process. `src/central/cooperative-process.test.ts` exercises it against a separate cooperative central process with synthetic clients, including replacement fencing. This is not a real agent integration. The listener waits up to five seconds for connections and accepted handler promises, then force-closes; upstream work can still continue and unknown outcomes must not be retried automatically.
2. Done locally: `scripts/real-agent-smoke.ts` runs Claude Code (owner-approved, default `~/.claude` login, Haiku) against the cooperative adapter over loopback. Two runs claimed one synthetic command and reported accepted, running and completed; see [central-server-status.md](central-server-status.md). With `--replacement` it also showed a real agent on the old incarnation being fenced and one on the new incarnation completing the next command, and the operator settling only the inactive incarnation's claim. With `--failure` a real agent refused a task, retried a report, sent rejected transitions and claimed an empty queue without extra records. With `--real-work` (owner-approved 2026-11-12) an agent with only the Read tool answered a question about fixture files in a separate workspace, with the correct answer and the files unchanged. The same script runs DSH instead with `--agent=dsh`; all modes passed once on 2026-11-13 (see status page).
3. Recovery for claims held by a dead incarnation: operator assertions exist (`cooperative-reconciliation.ts`), but no release or replay path, by design. Operator inspection shows `claim.incarnationActive`; `false` marks a claim nobody can report on any more. The owner chose option A from `docs/claim-recovery-proposal.md`: an operator may record one terminal settlement per claim, only after the claiming incarnation is inactive or its identity retired (`src/central/cooperative-settlement.ts`, `POST`/`GET /api/commands/:id/cooperative/settlement`). Settlement changes no command or lifecycle state and never re-runs work; inspection shows `claim.settled`. Late reports from a replaced incarnation (option B) and adoption (option C) are not implemented. A local PostgreSQL integration test reproduced a committed claim whose response is rejected by the adapter when command content contains the synthetic local bearer. Exact retries remain unreadable in that scenario; do not automatically requeue. A safe claim-response protocol remains open. The owner decided there will be no successor command; do not create one or automatically requeue.
4. Partly done locally: the disposable cooperative entry point uses a separate restricted runtime role and injects `schema-guard.ts` into each exposed cooperative store operation. With a runner, every public `CentralCommands` operation except `initialize()` runs inside the guard; other stores and callers are not uniformly guarded. The guard is not a sandbox or an integrity check (`pg_temp` stays on the path); see [central server status](central-server-status.md) before extending the exposed surface.
5. The legacy supervisor MCP uses a transactional active-identity guard for its exposed reads and writes. `src/central/legacy-identity-lock-pg.test.ts` shows in PostgreSQL that all 10 guarded supervisor tools wait for a retirement holding the lock and then fail closed with no write or data returned. It also shows that a retirement waits for `run_register` or `command_respond` holding the lock. A meta test keeps the table equal to the registered supervisor tool set. The guard is not incarnation fencing. Both central entry points drain in-flight requests on SIGINT/SIGTERM for up to 10 s before force-closing. No migration from the legacy entry point (`src/central/main.ts`): the owner confirmed on 2026-11-12 that there is no legacy data worth keeping (option A in [legacy-migration-proposal.md](legacy-migration-proposal.md)). One manual restore rehearsal into a throwaway database was done (see the backup note above); there is still no restore script. Both entry points have optional loopback TLS (`CENTRAL_TLS_CERT_FILE`/`CENTRAL_TLS_KEY_FILE` and `COOPERATIVE_TLS_CERT_FILE`/`COOPERATIVE_TLS_KEY_FILE`); the key file must be private to the running user. The approved two-host deployment uses Tailscale Serve for certificate management and tailnet HTTPS; see the deployment plan.
6. Persistent cooperative service (owner-approved 2026-11-13): [deploy/cooperative](../deploy/cooperative/README.md) runs `src/central/cooperative-service.ts` and PostgreSQL 17 with docker compose. Verified locally with a synthetic client, including a container restart that kept the incarnation. Deployed on `.15` (loopback, port 4881) on 2026-11-13 with synthetic checks including a container restart and an incarnation replacement; open items are in [deploy-15-plan.md](deploy-15-plan.md).

The delivery-attempt, host-socket, executor, journal and outbox modules are building blocks with no end-to-end path. The journal now rejects writes inside a caller transaction; `openExclusiveJournal` in `src/host-agent/executor-lease.ts` takes a cross-process lease (an exclusive SQLite lock on `<journal>.executor-lock`, freed by the OS when the holder dies) before restart reconciliation, so a second executor using it cannot mark a live one's started attempts as unknown. The journal holds the lease and refuses writes after release. Symlinked or relative spellings share one lock; hard links do not. The lease is cooperative: code that opens the journal directly bypasses it, and no runtime uses it yet.

## Previous: pinned agent-fleet dependency

The decentralized client was merged via PR #3 (`e9bbcbe`). Follow-up branch `chore/pin-agent-fleet` adds `vendor/agent-fleet` as a Git submodule pinned to `5871fa5306ab5f547b9b012018c27fe99ad008a0` (includes PR #7 paste-keys fix). All host entry points and tests now default to that CLI via `src/fleet/path.ts`; explicit `READONLY_FLEET_BIN`, then `FLEET_BIN`, still override it. No plugin-cache or developer-home fallback remains.

Clone with `--recurse-submodules`; existing checkouts run `git submodule update --init --recursive`. See [dependency maintenance](agent-fleet-dependency.md) for updates and rsync copies. Running host services were not changed.

Verification without CLI overrides: **164 pass, 0 skip, 0 fail**, 1076 assertions; typecheck clean in 43 files; design handler check PASS. The real read-only-viewer-plus-send test now runs and verifies `GOT-ENTER` with the command ID. Old-CLI rejection uses a deterministic fixture rather than silently returning when a current CLI is installed. These are local shell compatibility checks, not paid-agent or remote deployment proof.

## Previous: decentralized client

Branch `feat/decentralized-client`, based on `origin/main` at `14cf31e`, in `.agents/worktrees/feat-fleet-adapter`. One MacBook page can now select independent configured host services through a loopback gateway. Host execution and durable state remain remote; there is no central scheduler or duplicated tmux/SSH manager.

Read [multi-host setup](multi-host.md), [completed implementation plan](decentralized-client-plan.md), and [verification evidence](evidence-2026-11-09-multi-host.md). `bun run client` reads `FLEET_CONTROL_CLIENT_CONFIG`; `bun run demo:two-hosts` provides shell-only local fixtures. Tokens stay outside browser JavaScript. Remote host connections require verified TLS.

Verified locally: 161 tests passed, 3 skipped, 0 failed; typecheck clean; design handler check PASS. Actual independent services/SQLite/private tmux fleets and desktop/narrow browser renders were exercised. The skip is the separate agent-fleet viewer/send compatibility regression. No Linux deployment or paid agent test is claimed.

Historical next step at that point: review/merge and obtain remote authorization. The later owner approvals for `.15` deployment, Tailscale Serve and cooperative adapters supersede that hold only for those scopes (see current section above). The installed legacy `.4` service remains separate and must not be upgraded without permission.

## Selected design baseline

Stable entry: `docs/design/terminal-deck.html`.

It is an exact copy of `.design/drafts/console/terminal-deck/v4.html`, not a new implementation. The user selected Terminal Deck and then requested the changes embodied in v2-v4. This is the latest handoff baseline; it does not mean every interaction has received final product acceptance.

Visual references:

- [Desktop dark](design/desktop-dark.png)
- [Desktop light](design/desktop-light.png)
- [Phone dark](design/phone-dark.png)
- [Phone light](design/phone-light.png)

The phone screenshots contain a real 390px layout inside the rendering tool's 500px frame; the grey strip on the right is not application chrome.

[manifest.json](design/manifest.json) records source files and SHA-256 hashes. Copies were compared with their sources, and PNG signatures/dimensions were checked. These are same-machine design snapshots, not backups.

Preserve historical drafts. When the selected design changes, update the baseline, manifest and documentation together; do not let the stable snapshot and selected draft diverge silently.

## Decisions to preserve

- Remote supervisor: execution and durable state belong on the workstation. MacBook is a client and can go offline.
- Reuse agent-fleet CLI for existing session operations. Extend phased-delivery where structured state and decisions are needed.
- Browser terminals use ghostty-web and a read-only Bun PTY/WebSocket transport through agent-fleet. Writable terminal input is not implemented.
- Full-window UI with no outer frame, margin or rounded application shell.
- Only one host/session navigation, on the left. Hosts have distinct headers and nested session rows.
- Selecting a host shows all its available session views; selecting a child changes emphasis without dropping its siblings.
- Right sidebar for requests, workflow, evidence and command/response history. The bottom tray was explicitly rejected.
- No permanent top-level Text/State selects. Small view options live in an overflow menu.
- Use Apple HIG through Docify, registered as `apple-his@1.0.0`, and the selected tokens. Do not substitute an unrelated dashboard style.
- Queued, delivered, accepted and completed are separate facts. An approval is scoped to a phase revision and does not imply the next phase started.
- The local assistant relays user authority; it is not a second supervisor that can approve its own sensitive requests.

## Model per session

The user requested the model currently used by each session. The baseline mockup (v4) has no model label. The live page shows it from a Claude Code observer; see [model-observability.md](model-observability.md).

Presentation: a compact label beside the session name, with details for full identity, observation source and time. Distinguish observed, configured-only, unknown/stale and not-applicable. Never present a configured default as a verified runtime observation. A shell watchdog is not an LLM session.

## What actually exists

- A Bun-initialized project with documentation and static interactive designs.
- `index.ts` starts the host service: fleet CLI adapter, read-only terminal, durable commands, scoped requests, MCP, model observer, token auth and optional TLS. The original feature branch was merged. A launchd test service was installed on `.4`. This project installed no host service on `.15`; since 2026-11-13 that host has the separate cooperative central and adapter (see the latest section).
- v4 includes synthetic terminal output, in-memory requests, demo approvals and a command composer.
- `bun run design:check` checks the preserved design's handlers with a minimal DOM fixture.

The section above describes the original handoff. For what exists now, read [implementation-status.md](implementation-status.md). The apparent worker/reviewer terminals are illustrative: the inspected phased-delivery implementation uses Agent subagents, not guaranteed standalone tmux sessions.

## Verification at handoff

- Design HTML and four PNGs copied without changing their bytes; SHA-256 equality confirmed.
- PNG dimensions checked: desktop 1440x900; phone screenshot frames 500x844 containing the 390px layout.
- `bun run design:check`: exit 0 against the preserved design. Checks include blank input, escaped command text, queued-only receipt, approval awaiting acknowledgement, no automatic next-phase start, decline and disconnected refusal.
- Earlier design-studio renders were inspected in light/dark desktop and phone layouts. This handoff reuses those saved renders; it is not a new visual revision.

The handler check is not browser automation. These bullets record the original design handoff only. Later service, browser, restart and installation evidence appears below and in implementation status; it is not production verification.

## Session 2 update (2026-11-09)

- Plan stages 1-6 proposed; user asked to proceed as a goal. Stages 1-2 done locally on branch `feat-fleet-adapter` (worktree `.agents/worktrees/feat-fleet-adapter`). Details and verification: [implementation status](implementation-status.md). Not merged into main.
- Target hosts named by the user: `192.168.50.15` (SSH as root, port 27022) and `192.168.50.4`. Access from the MacBook over LAN and Tailscale. Not contacted yet.
- User decisions (2026-11-09, asked one at a time): both hosts are **peers, each with its own Fleet Control service** (two independent fleets grouped in the left nav, no shared scheduler). SSH: `.15` as `root` port 27022, `.4` as `me` port 22. Execution user on both: `me` (`.15` via `REMOTE_USER=me`).
- Read-only reconnaissance (approved, one SSH call per host, 2026-11-09):

| | 192.168.50.15 | 192.168.50.4 |
| --- | --- | --- |
| Hostname | me-desktop | Mac-mini-Mariusz.local |
| OS | Manjaro Linux, kernel 6.12, x86_64 | macOS (Darwin 27.2), arm64 |
| Tailscale IPv4 | 100.64.0.5 | 100.64.0.6 |
| User `me` | uid 1000, groups incl. wheel, docker | uid 501, admin |
| tmux | 3.7c | 3.8 (Homebrew, installed 2026-11-09 with approval) |
| bash | 5.3 | 5.3 in /opt/homebrew/bin (installed 2026-11-09); /bin/bash 3.2 and login shell /bin/zsh unchanged |
| bun / claude / git / rg | 1.4.0 / 2.1.319 / 2.55 / 15.2 | 1.4.4 / 2.1.311 / 2.54 / 15.2 |
| agent-fleet plugin | 0.3.0, installed 2026-11-09 with user approval (`claude plugin install agent-fleet@kolezka --scope user` as me); `scripts/fleet` and `watchdog.sh` SHA-256 identical to the MacBook copy | 0.3.0 |
| Disk free (home fs) | **64G free, 93% used** | 134G free |
| Live tmux | production sessions `tv-*` incl. `tv-watchdog` on the default socket, plus leftover `fleet-fleetsmoke*` sockets | none (tmux was missing at recon) |

  Consequences: on `.4` the fleet CLI (`#!/usr/bin/env bash`) needs `/opt/homebrew/bin` first in PATH, which a non-login SSH command or launchd job does not get by default; the service must set PATH explicitly. `.15` runs a production fleet (`tv-*`); never attach to, send to or kill those sessions; tests use their own private socket. Low disk on `.15` is a risk for worktrees.
- User then said: do not touch `192.168.50.15` for now. No further contact with either host after the installs above.
- Approved: `ghostty-web` 0.4.0 pinned in this worktree; a local agent-fleet worktree adding `fleet attach --read-only` (no push).
- Stage 3 (read-only terminal) done locally on the MacBook against a private test fleet: see [implementation status](implementation-status.md). The agent-fleet change lives on branch `feat/attach-read-only` in `~/Development/agent-fleet.worktrees/attach-read-only` was merged as kolezka/agent-fleet#6 (`8a1bd2c`). The plugin version was not bumped (still 0.3.0), so installed plugin caches lack it and Fleet Control still needs `READONLY_FLEET_BIN` pointing at a checkout of agent-fleet `main` until a version bump ships.
- User chose option 2: no agent-fleet version bump for now, stage 4 locally.
- Stage 4 (durable command queue, `fleet send` delivery, MCP at `/mcp` and REST at `/api/commands`) done locally: see [implementation status](implementation-status.md). Then, with paid-agent approval, one Haiku test supervisor with only the MCP tools accepted, completed and rejected commands; evidence from the database in `docs/evidence-2026-11-09-supervisor-ack.txt`, cost $0.0029. Found: `NO_COLOR=1` makes agent-fleet mistake the prompt suggestion for typing (fleet send exit 4).
- User (2026-11-09): describe the NO_COLOR bug for another session (done: `docs/bugs/agent-fleet-no-color-user-typing.md`), do stage 5 on `192.168.50.4` so the MacBook stays free, and wire the page composer.
- Stage 5 (scoped requests, phase record, approval gate, page panel) done; tests and a browser check ran on `.4` in a private checkout with private tmux sockets on loopback. See [implementation status](implementation-status.md). Found: a read-only viewer makes `tmux send-keys` fail (`client is read-only`), so `fleet send` and the watchdog cannot press Enter while the page is open: `docs/bugs/agent-fleet-send-keys-read-only-viewer.md`.
- Dev setup on `.4`: `rsync -az --delete --exclude node_modules --exclude .git ./ me@192.168.50.4:Development/fleet-control-dev/`, PATH `/opt/homebrew/bin:$HOME/.bun/bin`, agent-fleet `main` copy at `~/Development/agent-fleet-dev`. Nothing runs there after the session.
- Session 3 (user, 2026-11-09: finish what remains in fleet-control): model observation from Claude Code transcripts, token auth with configurable bind, terminal reconnect, peer hosts in the nav, narrow layout and a measured accessibility pass. See [implementation status](implementation-status.md). Branch has all commits; not merged, no push.

- Installed (owner approved, 2026-11-09): service on `.4` as LaunchAgent, LAN `192.168.50.4:4871` with mkcert TLS and tokens, test fleet only; MacBook MCP `fleet-control-mini` registered at user scope. MacBook-offline test passed. See [implementation status](implementation-status.md) and [installation](installation.md) (includes removal).

## Next action

See "Suggested next order" in [implementation-status.md](implementation-status.md). That list covers the host service; central work is in the remaining-work list in the latest section above. In short, for the host service: the agent-fleet `send-keys` fix is in the pinned CLI, but the installed `.4` service still runs the older copy; that service runs for a test fleet only (no Tailscale listener, owner decision); upgrading it or pointing it at a real fleet needs approval; then phased-delivery over MCP. `feat-fleet-adapter` was merged (PRs #1 and #2). This project installed no host service on `.15`. `runner-01` is only a design fixture.

Recheck Git state before changing code and keep using the worktree. The original handoff said no remote or push was authorized; that is out of date. The repository has a GitHub remote (`origin`) and work is published as pull requests. See the latest section for what the owner has authorized.

## Authorization boundary

The user approved the design direction, remote-supervisor architecture, local documentation and a handoff package. They did not authorize workstation access, real shell exposure, credential changes, production installation, deployment, spending, push or merge by approving these designs.

No secrets belong in project docs. Do not retry the denied Hindsight write without approval. The attempted external initiative capture was blocked; the authoritative handoff is local. Outline previously resolved this folder to a generic workspace project, so no new Outline task record was written under an assumed identity.

## Preview and tool caveats

From the project root:

```bash
open docs/design/terminal-deck.html
bun run design:check
```

`open` is the macOS viewer command. On another system, open the HTML with a browser. No web server is needed for the baseline.

A local design-studio canvas was started at `http://127.0.0.1:4870/` in the originating session. Its continued availability is not part of this handoff. Do not assume that a process currently occupying that port belongs to this project, and do not kill it without checking ownership. The files remain usable if the canvas stops.

Design-studio scripts came from the installed plugin, not from this project's runtime. Discover the installed skill path in a new environment rather than assuming the old plugin cache exists. The `.design/` generator scripts retain historical paths and refuse to overwrite their versions; do not rerun them as a project setup command.
