// Host service. Requires FLEET_CONF. Loopback without auth by default; set FLEET_CONTROL_HOST
// to another address only together with FLEET_CONTROL_TOKENS (see docs/installation.md).
import { serveOptionsFromEnv } from "./src/config.ts";
import { Commands } from "./src/data/commands.ts";
import { Deliverer, fleetSender } from "./src/delivery.ts";
import { FleetCli } from "./src/fleet/cli.ts";
import { resolveFleetBin } from "./src/fleet/path.ts";
import { Requests } from "./src/data/requests.ts";
import { observerForConf } from "./src/observe/claude.ts";
import { serve } from "./src/server.ts";
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
if (unknown.length) console.warn(`marked delivery_unknown after restart: ${unknown.join(", ")}`);

const server = serve(
  {
    fleet: new FleetCli({ fleetBin, confPath }),
    store,
    observer,
    terminal: { fleetBin, confPath },
    control: { commands, deliverer: new Deliverer(commands, fleetSender(fleetBin, confPath)), requests: new Requests(store.db) },
  },
  Number(process.env.PORT ?? 4871),
  await serveOptionsFromEnv(),
);
console.log(`Fleet Control service on ${server.url} (MCP at ${server.url}mcp)`);
