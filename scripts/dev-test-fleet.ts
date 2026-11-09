// Local demo: private test fleet (shell sessions only, no model) plus the service on 127.0.0.1.
// Never points at a real fleet. Ctrl-C kills the private tmux server.
import { Commands } from "../src/commands.ts";
import { Deliverer, fleetSender } from "../src/delivery.ts";
import { FleetCli } from "../src/fleet/cli.ts";
import { Requests } from "../src/requests.ts";
import { createTestFleet } from "../src/fleet/fixture.ts";
import { serve } from "../src/server.ts";
import { Store } from "../src/store.ts";

const fleetBin = process.env.READONLY_FLEET_BIN;
if (!fleetBin) throw new Error("READONLY_FLEET_BIN must point at a fleet CLI with attach --read-only");
const fleet = await createTestFleet(fleetBin);
const store = new Store(process.env.FLEET_CONTROL_DB ?? ":memory:");
store.upsertSession({ name: fleet.session, host: `${process.env.TEST_FLEET_HOST ?? (await import("node:os")).hostname()} (test fleet)`, role: "probe", kind: "script", configuredModel: null });
const commands = new Commands(store.db);
commands.reconcileAfterRestart();
const server = serve({
  fleet: new FleetCli({ fleetBin, confPath: fleet.confPath }),
  store,
  terminal: { fleetBin, confPath: fleet.confPath },
  control: { commands, deliverer: new Deliverer(commands, fleetSender(fleetBin, fleet.confPath)), requests: new Requests(store.db) },
}, Number(process.env.PORT ?? 4871));
console.log(`test fleet ${fleet.socket} · session ${fleet.session} · ${server.url} · MCP ${server.url}mcp`);
const stop = async () => { server.stop(true); await fleet.cleanup(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
