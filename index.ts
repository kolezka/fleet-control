// Local service. Requires FLEET_CONF; binds to 127.0.0.1 only and has no auth yet.
import { Commands } from "./src/commands.ts";
import { Deliverer, fleetSender } from "./src/delivery.ts";
import { FleetCli } from "./src/fleet/cli.ts";
import { defaultFleetBin } from "./src/fleet/fixture.ts";
import { serve } from "./src/server.ts";
import { Store } from "./src/store.ts";

const confPath = process.env.FLEET_CONF;
if (!confPath) {
  console.error("FLEET_CONF is required (path to an agent-fleet fleet.conf)");
  process.exit(1);
}
const fleetBin = process.env.READONLY_FLEET_BIN ?? defaultFleetBin;
const store = new Store(process.env.FLEET_CONTROL_DB ?? ":memory:");
const commands = new Commands(store.db);
const unknown = commands.reconcileAfterRestart();
if (unknown.length) console.warn(`marked delivery_unknown after restart: ${unknown.join(", ")}`);

const server = serve(
  {
    fleet: new FleetCli({ fleetBin, confPath }),
    store,
    terminal: { fleetBin, confPath },
    control: { commands, deliverer: new Deliverer(commands, fleetSender(fleetBin, confPath)) },
  },
  Number(process.env.PORT ?? 4871),
);
console.log(`Fleet Control service on ${server.url} (MCP at ${server.url}mcp)`);
