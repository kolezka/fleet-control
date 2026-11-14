# Installation CLI

This first version installs a fresh cooperative central, host adapter or local client from an already prepared checkout. It is not an upgrade tool or an installer for the separate legacy host service.

Use `bun fleet-control.ts --help` (or `bun run fleet-control --help`). Installation requires an explicit plan or apply flag. Planning does not connect over SSH or start services; it describes intent, not verified remote readiness.

## Prepare the target

Prepare a stable checkout with its pinned dependencies before using the CLI. Bun must already be installed. Central also needs Docker with Compose and a local daemon. Linux adapter installation also requires working local Docker to rule out the existing Compose adapter; it refuses to continue if that check is unavailable. Adapter and client use the current user's launchd on macOS or systemd user manager on Linux. No root or sudo is used. Linux services need an available user manager; continued operation after logout depends on separately configured user lingering.

The checkout must remain in place while installed services use it. Do not install from a disposable worktree. Do not point this fresh-only installer at the existing deployed hosts or state.

Config files and token files must be private, owned regular files. Use normalized absolute paths without symlink components. Adapter credentials and incarnation must already be provisioned by the central administrator. The CLI consumes their existing private adapter config; it does not enroll or replace a supervisor. See [adapter configuration](../deploy/cooperative/README.md#persistent-adapters-and-tailnet-access). Client configuration and separate token files follow [multi-host setup](multi-host.md), including optional cooperative command mapping. Never put tokens in CLI arguments.

## Local use

Example paths below are placeholders. Planning first does not authorize a later apply; review the plan before executing the same options with `--apply`.

```bash
bun fleet-control.ts doctor --code /absolute/fleet-control

bun fleet-control.ts install central --plan \
  --code /absolute/fleet-control \
  --state /absolute/private/fresh-central --host-id workstation

bun fleet-control.ts install adapter --plan \
  --code /absolute/fleet-control --config /absolute/private/adapter.json

bun fleet-control.ts install client --plan \
  --code /absolute/fleet-control --config /absolute/private/client.json
```

Central delegates to the existing [Compose setup](../deploy/cooperative/README.md). Its Docker build may fetch base images and build dependencies; the CLI does not bootstrap host dependencies. Fresh setup initializes PostgreSQL, credentials and the first local supervisor incarnation, then starts the loopback central service. This is an explicit first-install action, never an implicit reactivation of an existing installation. Adapter and client installation creates a new user-service definition referencing the existing runtime and config. Automatic crash restart is disabled; runtime stdout and stderr go to the null device to avoid leaking credentials. This gives up service logs and automatic recovery. All listeners remain loopback-only. Installing an adapter does not run an agent.

## Local page

The same local plan and apply are available as a page in the client gateway. It installs on the machine that runs the gateway only: there is no SSH target, and the checkout and Bun runtime are always the ones the gateway itself runs from.

```bash
bun fleet-control.ts ui              # loopback page on port 4880, no hosts needed
bun fleet-control.ts ui --port 4899
FLEET_CONTROL_INSTALLER=1 bun client.ts /absolute/private/client.json   # adds the page to a running client
```

Open `/install`. Choose a role, fill in the same options as the CLI and preview the plan. A preview checks and changes nothing. "Check prerequisites" runs the same `doctor` as the CLI.

The gateway has no login, so apply needs two things. First, the apply code: a random value written at start to a private file (mode 0600 in a 0700 directory) whose path is printed in the terminal. The code is never printed and the file is removed when the gateway stops. Second, the exact plan you previewed: if any option changes after the preview, apply is refused until you preview again.

One apply runs at a time. The Result panel reports that the installer exited, not that the service is healthy. If the page gets no answer to an apply, it says the outcome is unknown and does not retry; inspect the machine.

The page is off by default. Installed services never enable it, and the gateway returns 404 for the page and its API unless it was started as above. Requests are accepted only from the gateway's own loopback origin. This protects against other web pages and other OS users. It does not protect against a process running as you, which can read the code file.

## SSH use

The same checkout and CLI must already exist on the remote target. There is no archive transfer, git clone, dependency bootstrap or credential transfer. Remote paths refer to the target machine.

```bash
bun fleet-control.ts install adapter --plan \
  --ssh user@host --code /absolute/remote/fleet-control \
  --bun /absolute/remote/bun --config /absolute/remote/private/adapter.json
```

SSH uses batch authentication and strict host-key verification. Establish the trusted host key separately; the installer never accepts a new key automatically. Use your SSH configuration for identities and connection settings, or `--ssh-port` for an explicit port. A connection failure has no automatic retry. A disconnected apply may have changed the target; inspect it manually rather than retrying blindly.

## Boundaries and recovery

- Existing installation artifacts are refused rather than overwritten. Central must not reuse the globally named Compose project.
- No updates, restore, uninstall, dependency installation, Tailscale changes, backup schedules, agent launch or command replay.
- Prerequisite checks and service-manager acceptance are not application readiness or an end-to-end agent test.
- If apply fails after creating files or starting services, stop and inspect the target privately; command output is suppressed. Do not delete state or rerun blindly. There is no automatic rollback of external side effects.
- Runtime credentials remain in private files. Plans and service definitions contain file paths, not credential values.

Verification for the CLI uses local temporary fixtures and fake service managers, Docker and SSH. It does not establish a successful real macOS/Linux service installation or remote deployment.

Verification for the local page: the API and page logic run against fixtures, including one apply through the real executor with a fake service manager and a temporary home. The page was also opened in a real browser on macOS for preview, prerequisite check, the stale-plan gate and layout at four window widths. No apply was run against a real home directory, so a real service installation through the page is not established either.
