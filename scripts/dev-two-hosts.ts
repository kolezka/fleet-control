import { resolveFleetBin } from "../src/fleet/path.ts";
// Two local services with separate shell-only fleets. Not a Linux/macOS deployment test.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, newToken, tokenLine, parseTokens } from "../src/auth.ts";
import { Commands } from "../src/data/commands.ts";
import { Deliverer } from "../src/application/delivery.ts";
import { fleetSender } from "../src/fleet/sender.ts";
import { FleetCli } from "../src/fleet/cli.ts";
import { createTestFleet, type TestFleet } from "../src/fleet/fixture.ts";
import { Requests } from "../src/data/requests.ts";
import { serve } from "../src/server.ts";
import { Store } from "../src/data/store.ts";

const fleetBin = resolveFleetBin();
const dir = await mkdtemp(join(tmpdir(), "fleet-control-two-hosts-"));
const fleets: TestFleet[] = [];
const servers: ReturnType<typeof serve>[] = [];
const stores: Store[] = [];
let stopping = false;
const cleanup = async () => {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.stop(true);
  await Promise.all(fleets.map((fleet) => fleet.cleanup()));
  for (const store of stores) store.db.close();
  // dir is a unique directory created by this process, never an operator-supplied path.
  if (dir.startsWith(join(tmpdir(), "fleet-control-two-hosts-"))) await rm(dir, { recursive: true, force: true });
};
process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });

try {
  const hosts = [];
  for (const id of ["alpha", "beta"]) {
    const fleet = await createTestFleet(fleetBin);
    fleets.push(fleet);
    // Input is echoed by cat, never evaluated by a shell.
    await fleet.tmux("respawn-pane", "-k", "-t", fleet.session, `printf '%s\\n' 'HOST-${id.toUpperCase()}-TERMINAL'; exec cat`);
    const store = new Store(join(dir, `${id}.db`));
    stores.push(store);
    store.upsertSession({ name: fleet.session, host: id, role: "test", kind: "script", configuredModel: null });
    if (id === 'alpha' && process.argv.includes('--two-panes')) {
      const second = 'probe-observer';
      const config = await Bun.file(fleet.confPath).text();
      await Bun.write(fleet.confPath, config + `\nAGENTS+=("${second}|Probe observer|observer.txt")\n`);
      const started = await fleet.tmux('new-session', '-d', '-s', second, '-x', '120', '-y', '30', 'exec sleep 3600');
      if (started.exitCode !== 0) throw new Error('Could not start the second local test session');
      store.upsertSession({ name: second, host: id, role: 'test', kind: 'script', configuredModel: null });
    }
    const commands = new Commands(store.db);
    const requests = new Requests(store.db);
    const compareDashboard = process.argv.includes('--v21-dashboard') && id === 'alpha';
    const tasks = compareDashboard ? [['A-17', 'Authorize the read API phase?'], ['A-18', 'Authorize fixture review?']] as const : [['review-scope', `Approve test scope on ${id}?`]] as const;
    for (const [index, [taskId, question]] of tasks.entries()) {
      const runId = index === 0 ? 'same-run' : 'fixture-review';
      requests.registerRun({ runId, orchestrator: fleet.session, phase: 'phase-1', projectId: id === 'alpha' ? 'Atlas' : 'Beacon', taskId });
      requests.create({ runId, origin: fleet.session, expectedRevision: 1, kind: 'approval', question, scope: 'Shell-only fixture. No phase is executed by this demo.' });
    }
    const token = newToken();
    const tokenFile = join(dir, `${id}.token`);
    await Bun.write(tokenFile, token, { mode: 0o600 });
    const server = serve({
      fleet: new FleetCli({ fleetBin, confPath: fleet.confPath }), store,
      terminal: { fleetBin, confPath: fleet.confPath },
      control: { commands, requests, deliverer: new Deliverer(commands, fleetSender(fleetBin, fleet.confPath)) },
    }, 0, { auth: new Auth(parseTokens(tokenLine(`${id}-operator`, token))), hostName: `${id} (local test)` });
    servers.push(server);
    hosts.push({ id, name: `${id} (local test)`, url: server.url.origin, tokenFile });
    console.log(`${id}: ${server.url} · ${fleet.socket} · ${fleet.session}`);
  }
  const config = join(dir, "client.json");
  await Bun.write(config, JSON.stringify({ hosts }, null, 2));
  console.log(`Client config: ${config}`);
  console.log(`Start another terminal: FLEET_CONTROL_CLIENT_CONFIG='${config}' bun run client`);
  console.log("These are two independent local test services, not remote Linux/macOS hosts. Ctrl+C removes only these fixtures.");
} catch (error) {
  await cleanup();
  throw error;
}
