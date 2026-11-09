// Local read-only service. Requires FLEET_CONF; binds to 127.0.0.1 only.
import { FleetCli } from "./src/fleet/cli.ts";
import { defaultFleetBin } from "./src/fleet/fixture.ts";
import { serve } from "./src/server.ts";
import { Store } from "./src/store.ts";

const confPath = process.env.FLEET_CONF;
if (!confPath) {
  console.error("FLEET_CONF is required (path to an agent-fleet fleet.conf)");
  process.exit(1);
}
const store = new Store(process.env.FLEET_CONTROL_DB ?? ":memory:");
const server = serve({ fleet: new FleetCli({ fleetBin: defaultFleetBin, confPath }), store }, Number(process.env.PORT ?? 4871));
console.log(`Fleet Control read-only service on ${server.url}`);
