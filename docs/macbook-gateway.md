# Moving the Fleet Control gateway from the Mac mini to the MacBook

The gateway on the Mac mini (`~/fleet-control-gateway`, http://127.0.0.1:4870, pid in `lsof -nP -iTCP:4870`) was used for the stage 9 run on 2026-11-22. Screens of that run are in [stage9/](stage9/) (00 to 27).

The cleanest move does not copy any token. Start an empty gateway on the MacBook, add both hosts again from its own page, then remove the Mac mini gateway's access.

## 1. On the MacBook

```bash
git clone https://github.com/kolezka/fleet-control.git ~/fleet-control-gateway
cd ~/fleet-control-gateway
git submodule update --init --recursive
bun install --frozen-lockfile
mkdir -p ~/.config/fleet-control-gateway && chmod 700 ~/.config/fleet-control-gateway
echo '{"hosts": []}' > ~/.config/fleet-control-gateway/client.json
chmod 600 ~/.config/fleet-control-gateway/client.json
FLEET_CONTROL_ENROLL=1 bun client.ts ~/.config/fleet-control-gateway/client.json
```

Open http://127.0.0.1:4870/ and press **Add a host** (bottom of the host list).

## 2. Add the two hosts (Connect mode)

| Field | Mac mini (.4) | local-arch (.15) |
| --- | --- | --- |
| Id | `mini` | `arch` |
| Address | `https://mac-mini-mariusz.tail4a51cb.ts.net:4871` | `https://local-arch.tail4a51cb.ts.net:4871` |
| Principal | `macbook-pro` | `macbook-pro` |
| Folder | `/Users/me/Development/fleet-control-service` | `/home/me/Development/fleet-control-service` |

Use a new principal name (`macbook-pro`), not `macbook-gateway`: that name is already taken by the Mac mini gateway and the paste command refuses a second token for it.

For each host: press **Create**, copy the one-line command, run it on that host (on .15: `ssh -p 27022 me@192.168.50.15`, with `~/.bun/bin` on PATH), then press **Check**. The command carries only a hash of the token; the token itself stays in `~/.config/fleet-control-gateway/token-<id>` on the MacBook.

## 3. Check it works

From the MacBook page: both hosts in the left list with their sessions, open a pane, start and stop a small agent, send a command. That repeats screens 06 to 13.

## 4. Remove the Mac mini gateway

On the Mac mini:

```bash
kill "$(lsof -t -nP -iTCP:4870 -sTCP:LISTEN)"
rm -r ~/.config/fleet-control-gateway ~/fleet-control-gateway   # its token files and the clone
```

On each host, revoke its token and reload the service:

```bash
# .4
cd ~/Development/fleet-control-service && bun scripts/tokens.ts revoke macbook-gateway ~/.config/fleet-control/tokens
launchctl kill HUP gui/$(id -u)/pl.raqz.fleet-control
# .15
cd ~/Development/fleet-control-service && bun scripts/tokens.ts revoke macbook-gateway ~/.config/fleet-control/tokens
systemctl --user kill -s HUP fleet-control
```

Afterwards a request with the old Mac mini gateway token answers 401.

## Known points from the run

- The gateway keeps no state other than its config and token files. Closing the MacBook stops nothing on the hosts.
- Typing into a terminal needs **Type…**, then **Confirm** within 8 s; the lease lasts 5 minutes and ends when the pane closes.
- If the panel shows an old run instead of the current one, the host is older than PR #203 (fix: the panel shows the run updated last).
- A test-fleet tmux server started from a shell with `NO_COLOR=1` makes Claude Code's grey suggestion look like typed text, and the watchdog then refuses to send commands. On .4 this was fixed with `tmux -L fleet-fctrl-test set-environment -g -u NO_COLOR`; start fleet tmux servers from a normal terminal.
