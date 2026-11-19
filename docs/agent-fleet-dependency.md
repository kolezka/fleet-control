# Pinned agent-fleet dependency

Fleet Control references [agent-fleet](https://github.com/kolezka/agent-fleet) as a Git submodule at `vendor/agent-fleet`. The Git tree records the exact commit, not a floating branch. Initial pin: `5871fa5306ab5f547b9b012018c27fe99ad008a0`, including read-only attach and the paste-keys fix merged in PR #7. Current pin: `5c57a62cec1031fc4e2bebe7caf2a15518b9a675` (agent-fleet 0.5.0, PR #12), which adds the optional `agent_overrides` hook (per-agent folder and Claude Code arguments on every start and replacement) and writes prompt copies readable by the owner only; Fleet Control's managed agents need it. Earlier pin: `3bd26d8acfa5a7a7ab20021cf8dbadee9d321b04` (agent-fleet 0.4.0, PR #10), which added `AGENT_KIND=dsh`: fleet agents can run in DeepSeek Harness through `scripts/dsh-agent.mjs`, a terminal front end that runs each message as one `dsh --profile headless` turn in the same DSH session. The Claude Code path is unchanged.

## Install and update

```bash
git clone --recurse-submodules git@github.com:kolezka/fleet-control.git
cd fleet-control
bun install --frozen-lockfile
```

For existing Git checkouts, including after pulling a new Fleet Control commit:

```bash
git submodule update --init --recursive
git submodule status
```

For rsync deployments, initialize the source first and copy the files inside `vendor/agent-fleet/` too. Excluding `.git` is fine for a deployment copy, but that copy cannot update the pin itself. No service update happens just because a dependency pin changes in a development checkout.

## CLI resolution

All host entry points and integration tests use `src/fleet/path.ts`:

1. Explicit `READONLY_FLEET_BIN`.
2. Explicit `FLEET_BIN`.
3. Repository-relative `vendor/agent-fleet/scripts/fleet`, independent of the process working directory.

A missing chosen path fails with the submodule initialization command. There is no silent fallback to plugin caches or a developer's home directory. Overrides remain useful for compatibility testing, but can select older or incompatible code. The MacBook client gateway does not execute the CLI and needs no local fleet.

Bun, tmux and bash requirements are unchanged. The submodule does not install a Claude Code plugin, start an agent or manage another repository's changes. Make agent-fleet code changes in its own repository and pin a reviewed upstream commit here.

## Deliberately advance the pin

In an isolated Fleet Control worktree:

```bash
git -C vendor/agent-fleet fetch origin
git -C vendor/agent-fleet checkout <reviewed-commit>
env -u NO_COLOR bun test
bun check
bun run design:check
git diff --submodule=log
git add vendor/agent-fleet
git commit -m "chore: update agent-fleet pin"
```

Do not use `git submodule update --remote` for normal installation: it selects newer dependency code instead of the tested pin. To roll back, restore the previous Fleet Control gitlink in a new commit, then run `git submodule update --init --recursive` and verify again.

## Verification of the initial pin

The local suite executes the real pinned CLI against private shell-only tmux sockets. This includes `fleet send` while a read-only viewer is attached: the command reaches `delivered` and the reader prints `GOT-ENTER` with its command ID. No paid agent or production session is used. This is CLI compatibility evidence, not a Linux deployment or production-agent test.
