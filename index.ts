// Host service. Requires FLEET_CONF. Loopback without auth by default; set FLEET_CONTROL_HOST
// to another address only together with FLEET_CONTROL_TOKENS (see docs/installation.md).
import { portFromEnv, reloadTokensOnHangup, serveOptionsFromEnv, tailnetOptionsFromEnv } from "./src/config.ts";
import { Commands } from "./src/data/commands.ts";
import { Deliverer } from "./src/application/delivery.ts";
import { fleetSender } from "./src/fleet/sender.ts";
import { FleetCli } from "./src/fleet/cli.ts";
import { resolveFleetBin } from "./src/fleet/path.ts";
import { Requests } from "./src/data/requests.ts";
import { observerForConf } from "./src/observe/claude.ts";
import { serve, ViewerSlots } from "./src/server.ts";
import { Store } from "./src/data/store.ts";

const confPath = process.env.FLEET_CONF;
if (!confPath) {
  console.error("FLEET_CONF is required (path to an agent-fleet fleet.conf)");
  process.exit(1);
}
const fleetBin = resolveFleetBin();
const observed = await observerForConf(confPath);
if ("disabled" in observed) console.warn(`model observation off: ${observed.disabled}`);
const observer = "disabled" in observed ? undefined : observed;
const store = new Store(process.env.FLEET_CONTROL_DB ?? ":memory:");
const commands = new Commands(store.db);
const unknown = commands.reconcileAfterRestart();
if (unknown.length) console.warn(`delivery outcome unknown after restart: ${unknown.join(", ")}`);

const options = await serveOptionsFromEnv();
const port = portFromEnv(process.env.PORT);
// Checked before anything binds, so a bad tailnet setting does not leave a half-started service.
const tailnet = await tailnetOptionsFromEnv(process.env, options, port);
reloadTokensOnHangup(options.auth);
// One set of dependencies: both listeners share the store, the queue, the one delivery at a time and the tokens.
const deps = {
  fleet: new FleetCli({ fleetBin, confPath }),
  store,
  observer,
  terminal: { fleetBin, confPath },
  control: { commands, deliverer: new Deliverer(commands, fleetSender(fleetBin, confPath)), requests: new Requests(store.db) },
};
// One cap on terminal PTYs for the whole process, whichever listener the socket came in on.
const viewerSlots = new ViewerSlots();
const server = serve(deps, port, { ...options, viewerSlots });
if (tailnet) {
  try {
    const second = serve(deps, server.port, { ...tailnet, viewerSlots });
    console.log(`Fleet Control tailnet listener on ${second.url} as https://${process.env.FLEET_CONTROL_TAILNET_NAME}:${second.port}/`);
  } catch (e) {
    // Half a service looks up to a supervisor; stop the LAN listener and fail the start instead.
    server.stop(true);
    console.error(`tailnet listener failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
console.log(`Fleet Control service on ${server.url} (MCP at ${server.url}mcp)`);
