import { resolveFleetBin } from "../src/fleet/path.ts";
// Local demo: private test fleet (shell sessions only, no model) plus the service on 127.0.0.1.
// Never points at a real fleet. Ctrl-C kills the private tmux server.
import { Commands } from "../src/data/commands.ts";
import { Deliverer } from "../src/application/delivery.ts";
import { fleetSender } from "../src/fleet/sender.ts";
import { FleetCli } from "../src/fleet/cli.ts";
import { Requests } from "../src/data/requests.ts";
import { createTestFleet } from "../src/fleet/fixture.ts";
import { observerForConf } from "../src/observe/claude.ts";
import { portFromEnv, reloadTokensOnHangup, serveOptionsFromEnv } from "../src/config.ts";
import { serve } from "../src/server.ts";
import { Store } from "../src/data/store.ts";

const fleetBin = resolveFleetBin();
const fleet = await createTestFleet(fleetBin);
const observed = await observerForConf(fleet.confPath);
if ("disabled" in observed) console.warn(`model observation off: ${observed.disabled}`);
const observer = "disabled" in observed ? undefined : observed;
const store = new Store(process.env.FLEET_CONTROL_DB ?? ":memory:");
store.upsertSession({ name: fleet.session, host: `${process.env.TEST_FLEET_HOST ?? (await import("node:os")).hostname()} (test fleet)`, role: "probe", kind: "script", configuredModel: null });
const commands = new Commands(store.db);
commands.reconcileAfterRestart();
const options = await serveOptionsFromEnv();
reloadTokensOnHangup(options.auth);
const server = serve({
  fleet: new FleetCli({ fleetBin, confPath: fleet.confPath }),
  store,
  observer,
  terminal: { fleetBin, confPath: fleet.confPath },
  control: { commands, deliverer: new Deliverer(commands, fleetSender(fleetBin, fleet.confPath)), requests: new Requests(store.db) },
}, portFromEnv(process.env.PORT, 4871, true), options);
console.log(`test fleet ${fleet.socket} · session ${fleet.session} · ${server.url} · MCP ${server.url}mcp`);
const stop = async () => { server.stop(true); await fleet.cleanup(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
