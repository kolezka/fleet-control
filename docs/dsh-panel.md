# Fleet Control inside DeepSeek Harness

The plugin in `dsh/` shows the Fleet Control page in the DeepSeek Harness (DSH) web app in two places: as a tab beside Chat and Trajectory in the conversation view, and as a right sidebar tab (in the More menu of the sidebar). Both show the same page; the fleet is one per machine, not per conversation.

Fleet Control still runs as its own service and its page keeps working on its own address. The plugin only forwards to it.

## How it works

- The DSH host half (`dsh/index.js`, `dsh/proxy.js`) serves the page below `/fleet-control/` on the DSH address. Every request first passes the DSH login check (`connection.requestRejection`): an unauthenticated or foreign-origin request never reaches Fleet Control.
- The proxy signs in to Fleet Control with a token of its own, read once from a file at start. The token never reaches the browser. DSH cookies and auth headers are not forwarded. Commands sent from the panel are recorded under that principal.
- The page's own sign-in and sign-out (`/login`, `/logout`, `/api/login`) are not offered under the prefix.
- Bun bundles the page with absolute `/_bun/...` paths; the proxy points those below the prefix. All other page paths are relative.
- DSH routes WebSocket upgrades by exact path only, so the read-only terminal uses one path, `/fleet-control/api/terminal?session=<name>`. The host service answers both this form and the old `/api/sessions/<name>/terminal` with the same checks. The socket stays read-only: Fleet Control closes it on any client message.
- The browser half (`dsh/client.js`) registers the two tabs. Each holds an iframe of `fleet-control/` on the DSH origin.

## Install

1. Create a principal for the panel on the host service and give the DSH process the token, without printing it:

   ```bash
   umask 077
   bun -e 'import { newToken, tokenLine } from "./src/auth.ts"; const t = newToken(); await Bun.write(process.env.HOME + "/.config/fleet-control/token-dsh-panel", t); console.log(tokenLine("dsh-panel", t));' >> ~/.config/fleet-control/tokens
   ```

   Restart the host service so it reads the new line.

2. Load the plugin through `~/.dsh/cordis.patch.yml`. `url` is the host service (https, or http on loopback), `tokenFile` the file from step 1 and `caFile` the certificate authority for a private certificate. The paths are not secrets; the token stays in its file.

   ```yaml
   - insert:
       - id: fleet-control-panel
         name: "file:///absolute/path/to/fleet-control/dsh/index.js"
         config:
           url: https://192.168.50.4:4871
           tokenFile: /Users/me/.config/fleet-control/token-dsh-panel
           caFile: /Users/me/.config/fleet-control/ca.pem
   ```

   The environment variables `FLEET_CONTROL_PANEL_URL`, `FLEET_CONTROL_PANEL_TOKEN_FILE` and `FLEET_CONTROL_PANEL_CA` are read when the config leaves a field out.

Without settings the plugin still loads; the page route then answers 503 with what is missing.

## Limits

- The terminal path of the page needs the host service built from this change; an older service answers 404 on `/api/terminal` and the panel shows the terminal as disconnected.
- Through a client gateway (`client.ts`) the panel is not supported yet: the gateway uses the path form for terminals.
- `dsh/proxy.test.ts` runs the proxy against a real host service with auth and a stand-in for the DSH login check. The tabs were checked by hand in the DSH web app on 192.168.50.4 (see implementation-status.md).
