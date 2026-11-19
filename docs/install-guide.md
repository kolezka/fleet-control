# Installing Fleet Control on a host

Step by step, from an empty machine to a service that starts by itself and that you can reach from the MacBook. This is the same procedure that was used on 192.168.50.4 (macOS). Commands marked **MacBook** run on the MacBook, **host** on the machine that runs the agents.

What you end up with:

- the service running as your user on the host, started by launchd at login and restarted after a crash;
- listening on the host's LAN address only, with TLS and tokens;
- the page at `https://<host>:4871/` and an MCP server in Claude Code on the MacBook.

Throughout, replace `192.168.50.4` with your host's address. The service must run as the same user that owns the fleet's tmux sessions (here `me`).

For a single MacBook view of several independent host services, install each host first, then follow [multi-host setup](multi-host.md). Linux systemd guidance is there; the steps below use macOS launchd. The MacBook gateway is not the host service and does not need a local fleet.

## 1. Prepare the host

**host** (macOS):

```bash
brew install tmux bash git
curl -fsSL https://bun.sh/install | bash        # Bun 1.4 or newer
tmux -V && /opt/homebrew/bin/bash --version | head -1 && ~/.bun/bin/bun --version
```

agent-fleet needs bash 4 or newer; macOS ships 3.2, hence Homebrew bash. launchd does not put `/opt/homebrew/bin` on PATH, so the service file below sets it.

## 2. Get the code onto the host

Fleet Control includes a pinned agent-fleet submodule. Initialize it when cloning or updating.

**host**, if it has GitHub access:

```bash
git clone --recurse-submodules git@github.com:kolezka/fleet-control.git ~/Development/fleet-control-service
cd ~/Development/fleet-control-service
~/.bun/bin/bun install --frozen-lockfile
./vendor/agent-fleet/scripts/fleet help | grep 'attach \[--read-only\]'  # must print a line
```

**MacBook**, if the host has no GitHub access (this is how .4 was set up): copy from your checkout.

```bash
cd ~/Development/fleet-control
git submodule update --init --recursive
rsync -az --delete --exclude node_modules --exclude .git --exclude .agents ./ me@192.168.50.4:Development/fleet-control-service/
ssh me@192.168.50.4 'cd ~/Development/fleet-control-service && ~/.bun/bin/bun install --frozen-lockfile'
```

## 3. Choose the fleet

The service watches one agent-fleet fleet, described by its `fleet.conf`. That file must sit inside the fleet's own directory (`FLEET_DIR`), because agent-fleet reads it from there.

Start with a test fleet. It has one shell session and no agent, so nothing can go wrong and nothing costs money.

**host**:

```bash
mkdir -p ~/.local/share/fleet-control/test-fleet
cat > ~/.local/share/fleet-control/test-fleet/fleet.conf <<EOF
# Test fleet: one shell session, no agent, private tmux socket fleet-fctrl-test.
FLEET=fctrl-test
FLEET_DIR=$HOME/.local/share/fleet-control/test-fleet
AGENTS=("probe-shell|Probe shell|probe.txt")
EOF
PATH=/opt/homebrew/bin:$PATH env -u NO_COLOR \
  tmux -L fleet-fctrl-test -f /dev/null new-session -d -s probe-shell -x 120 -y 30 "exec cat"
```

For a real fleet, use its existing `fleet.conf` instead and skip the tmux line. Read "Known limits" in the README first: the pinned CLI includes the viewer/send fix, but this does not establish production-agent safety.

## 4. Make a certificate

The MacBook signs a certificate for the host's address with [mkcert](https://github.com/FiloSottile/mkcert). Browsers and Claude Code on the MacBook then trust it with no warnings. The CA's private key never leaves the MacBook.

**MacBook**:

```bash
brew install mkcert
mkcert -install                       # once per MacBook; adds the CA to the keychain
cd "$(mktemp -d)"
mkcert 192.168.50.4                   # writes 192.168.50.4.pem and 192.168.50.4-key.pem
ssh me@192.168.50.4 'mkdir -p ~/.config/fleet-control && chmod 700 ~/.config/fleet-control'
scp 192.168.50.4.pem me@192.168.50.4:.config/fleet-control/cert.pem
scp 192.168.50.4-key.pem me@192.168.50.4:.config/fleet-control/key.pem
scp "$(mkcert -CAROOT)/rootCA.pem" me@192.168.50.4:.config/fleet-control/ca.pem   # public part only
ssh me@192.168.50.4 'chmod 600 ~/.config/fleet-control/key.pem'
rm 192.168.50.4-key.pem
```

Never copy `rootCA-key.pem`.

## 5. Make tokens

One token per client. The host keeps only hashes; each client keeps its own token.

**host**:

```bash
cd ~/Development/fleet-control-service
~/.bun/bin/bun scripts/new-token.ts web-mariusz ~/.config/fleet-control/tokens operator  # for the browser; only operators answer requests
~/.bun/bin/bun scripts/new-token.ts macbook-session ~/.config/fleet-control/tokens  # for Claude Code
```

Each command prints the token once. Save it on the MacBook, for example:

**MacBook**:

```bash
mkdir -p ~/.config/fleet-control && chmod 700 ~/.config/fleet-control
pbpaste > ~/.config/fleet-control/token-web-mariusz && chmod 600 ~/.config/fleet-control/token-web-mariusz
```

The token name is recorded as the author of everything that client does. To change tokens without editing the file by hand, use `scripts/tokens.ts` on the host, then tell the service to reread the file:

```bash
~/.bun/bin/bun scripts/tokens.ts list ~/.config/fleet-control/tokens
~/.bun/bin/bun scripts/tokens.ts rotate web-mariusz ~/.config/fleet-control/tokens   # prints the new token once
~/.bun/bin/bun scripts/tokens.ts revoke macbook-session ~/.config/fleet-control/tokens
~/.bun/bin/bun scripts/tokens.ts role dsh-panel operator ~/.config/fleet-control/tokens   # operator, agent (default) or viewer
```

Changes run one at a time through a `tokens.lock` file beside the tokens file; a second change waits up to 5 s. The lock holds the process id of the change. If a change was killed and left the lock behind, the next one refuses, names the file and says whether that process still runs; it never removes the lock itself.

Then reload, without dropping connections:

```bash
launchctl kill HUP gui/$(id -u)/pl.raqz.fleet-control
```

The service logs `tokens reloaded: N principal(s)`. If the file is unreadable or invalid it logs `tokens reload refused, previous tokens kept: <reason>` and keeps the old tokens. A removed or rotated token stops working on its next request, and any terminal viewer opened with it is closed at the reload (WebSocket close 1008, `token revoked`); viewers opened with other tokens stay open. Releases before this change (the `.4` service runs `59965a3`) have no SIGHUP handler, so a HUP ends the process; use `launchctl kickstart -k` there.

`rotate` replaces one hash and keeps the other lines and comments; the old token stops working at the reload. `revoke` refuses to remove the last principal, because the service would not start without one. Each change is checked the way the service checks the file and written atomically with mode 0600; a refused change leaves the file as it was. Token files are local to each host: rotating on one host does not touch another.

## 6. Try it in the foreground

**host**:

```bash
cd ~/Development/fleet-control-service
PATH=/opt/homebrew/bin:$HOME/.bun/bin:$PATH env -u NO_COLOR \
  FLEET_CONF=$HOME/.local/share/fleet-control/test-fleet/fleet.conf \
  READONLY_FLEET_BIN=$HOME/Development/fleet-control-service/vendor/agent-fleet/scripts/fleet \
  FLEET_CONTROL_DB="$HOME/Library/Application Support/fleet-control/state.db" \
  FLEET_CONTROL_HOST=192.168.50.4 \
  FLEET_CONTROL_HOST_NAME=mac-mini \
  FLEET_CONTROL_TOKENS=$HOME/.config/fleet-control/tokens \
  FLEET_CONTROL_TLS_CERT=$HOME/.config/fleet-control/cert.pem \
  FLEET_CONTROL_TLS_KEY=$HOME/.config/fleet-control/key.pem \
  bun index.ts
```

Create the database folder first: `mkdir -p ~/Library/Application\ Support/fleet-control`.

**MacBook**, in another terminal:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://192.168.50.4:4871/api/sessions    # 401: auth works
curl -s -H "Authorization: Bearer $(cat ~/.config/fleet-control/token-web-mariusz)" \
  https://192.168.50.4:4871/api/sessions                                           # JSON with probe-shell
```

If both look right, stop it with Ctrl+C on the host.

## 7. Run it in the background with launchd

**host**: this writes the service file with your paths filled in and starts it.

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/pl.raqz.fleet-control.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>pl.raqz.fleet-control</string>
  <key>ProgramArguments</key><array>
    <string>$HOME/.bun/bin/bun</string><string>index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME/Development/fleet-control-service</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>FLEET_CONF</key><string>$HOME/.local/share/fleet-control/test-fleet/fleet.conf</string>
    <key>READONLY_FLEET_BIN</key><string>$HOME/Development/fleet-control-service/vendor/agent-fleet/scripts/fleet</string>
    <key>FLEET_CONTROL_DB</key><string>$HOME/Library/Application Support/fleet-control/state.db</string>
    <key>FLEET_CONTROL_HOST</key><string>192.168.50.4</string>
    <key>FLEET_CONTROL_HOST_NAME</key><string>mac-mini</string>
    <key>FLEET_CONTROL_TOKENS</key><string>$HOME/.config/fleet-control/tokens</string>
    <key>FLEET_CONTROL_TLS_CERT</key><string>$HOME/.config/fleet-control/cert.pem</string>
    <key>FLEET_CONTROL_TLS_KEY</key><string>$HOME/.config/fleet-control/key.pem</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/fleet-control.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/fleet-control.log</string>
</dict></plist>
EOF
plutil -lint ~/Library/LaunchAgents/pl.raqz.fleet-control.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/pl.raqz.fleet-control.plist
launchctl print gui/$(id -u)/pl.raqz.fleet-control | grep -E 'state|pid'           # state = running
```

launchd does not pass `NO_COLOR` unless you add it, which is what we want. A LaunchAgent runs while you are logged in on the host; on .4 the user `me` stays logged in.

Then repeat the two `curl` checks from step 6.

## 8. Connect the clients

**Browser** on the MacBook: open `https://192.168.50.4:4871/`, paste the `web-mariusz` token (`pbcopy < ~/.config/fleet-control/token-web-mariusz`). You stay signed in for 30 days.

**Claude Code** on the MacBook:

```bash
claude mcp add --scope user --transport http fleet-control-mini https://192.168.50.4:4871/mcp \
  --header "Authorization: Bearer $(cat ~/.config/fleet-control/token-macbook-session)"
claude mcp list | grep fleet-control-mini       # ✔ Connected
```

Other Node or Bun programs talking to the service need `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`.

## Day to day

```bash
ssh me@192.168.50.4 'launchctl print gui/$(id -u)/pl.raqz.fleet-control | grep -E "state|pid"'   # status
ssh me@192.168.50.4 'launchctl kickstart -k gui/$(id -u)/pl.raqz.fleet-control'                  # restart
ssh me@192.168.50.4 'tail -50 ~/Library/Logs/fleet-control.log'                                  # log
ssh me@192.168.50.4 'launchctl bootout gui/$(id -u)/pl.raqz.fleet-control'                       # stop until next login
ssh me@192.168.50.4 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/pl.raqz.fleet-control.plist'  # start again
```

After a reboot the service comes back by itself, the test session does not. Start it again with the tmux line from step 3.

**Update** to a newer version: repeat step 2 (`git pull` or the `rsync` lines), then `git submodule update --init --recursive` (Git installs), `bun install --frozen-lockfile` and restart. With rsync, initialize the submodule on the source first and include `vendor/agent-fleet/` files. The database is kept.

**Uninstall**:

```bash
ssh me@192.168.50.4 'launchctl bootout gui/$(id -u)/pl.raqz.fleet-control; rm ~/Library/LaunchAgents/pl.raqz.fleet-control.plist; tmux -L fleet-fctrl-test kill-server'
claude mcp remove --scope user fleet-control-mini
# and, to delete data too, on the host:
# rm -rf ~/Development/fleet-control-service ~/.config/fleet-control ~/.local/share/fleet-control "$HOME/Library/Application Support/fleet-control" ~/Library/Logs/fleet-control.log
```

## When something is wrong

| Symptom | Cause and fix |
| --- | --- |
| `refusing to bind 192.168.50.4 without auth; set FLEET_CONTROL_TOKENS` in the log | The tokens file is missing or the variable is not set. |
| `tokens file line N: expected "<name> <sha256 hex> [role]"` | That line is not `<name> <64 hex chars>` with an optional role. Recreate it with `new-token.ts`. |
| `tokens file line N: role must be one of operator, agent, viewer` | The third column is not a known role. Fix it with `tokens.ts role`. |
| Approve in the page returns 403 `forbidden` | The token the page signed in with is not an `operator`. Run `tokens.ts role <principal> operator <tokens-file>` and send the service SIGHUP. |
| `curl` says the certificate is not trusted | `mkcert -install` was not run on this MacBook, or the certificate was made for another address. |
| Every request returns 401 | Wrong or revoked token. In the browser, open `/logout` and sign in again. |
| `SQLiteError: unable to open database file` | The folder for `FLEET_CONTROL_DB` does not exist. `mkdir -p` it. |
| Port 4871 is busy | Another copy is running: `lsof -nP -iTCP:4871 -sTCP:LISTEN`. |
| Sessions list is empty or says the session is missing | `fleet.conf` is not inside its `FLEET_DIR`, or the tmux session was not started (step 3). |
| Instructions stay "Delivery unknown" or "Queued" | `NO_COLOR` is set for the tmux server, or a read-only viewer blocks Enter until agent-fleet's `send-keys` fix is merged. |
| The terminal pane stays empty | `READONLY_FLEET_BIN` points at a `fleet` without `attach --read-only`. |

## Linux hosts

Not tested yet. The same steps apply, with a systemd user unit instead of launchd and without Homebrew paths. 192.168.50.15 is deliberately not set up.
