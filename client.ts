// MacBook client gateway entry. Loopback only; holds host tokens server-side and relays to each
// host's own Fleet Control service. Config: FLEET_CONTROL_CLIENT_CONFIG or the first CLI argument.
import { GatewayConfigError, loadGatewayConfig, startGateway } from "./src/client-gateway.ts";
import { createInstaller, localContext } from "./src/install/web.ts";
import { workstationPlanUseCases } from "./src/application/workstation-plans.ts";
import { workstationPlansFile } from "./src/data/workstation-plans.ts";
import { gatewayEnrollment } from "./src/gateway-enroll.ts";
import { gatewayHostManager } from "./src/gateway-hosts.ts";
import { portFromEnv } from "./src/config.ts";

const configPath = process.argv[2] ?? process.env.FLEET_CONTROL_CLIENT_CONFIG;
if (!configPath) {
  console.error("usage: bun client.ts <config.json>  (or set FLEET_CONTROL_CLIENT_CONFIG)");
  process.exit(1);
}
let port: number;
try {
  port = portFromEnv(process.env.PORT, 4870, true);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

let installer: Awaited<ReturnType<typeof createInstaller>> | undefined;
try {
  // Adding hosts from the page writes token files and this config. Off unless asked for.
  // With it on, the gateway may start with no hosts and the first one is added from the page.
  const enrolling = process.env.FLEET_CONTROL_ENROLL === "1";
  const config = await loadGatewayConfig(configPath, { allowNoHosts: enrolling });
  // Off unless asked for. Installed services do not set this.
  if (process.env.FLEET_CONTROL_INSTALLER === "1") installer = await createInstaller(localContext());
  // Saved plans for new machines live in their own file next to the config.
  const enroll = enrolling ? gatewayEnrollment(configPath, config, workstationPlanUseCases(workstationPlansFile(`${configPath}.workstation-plans.sqlite`), () => config.hosts.map((h) => h.id))) : undefined;
  // The same switch lets the page rotate this gateway's token for a host and remove a host.
  const manage = enrolling ? gatewayHostManager(configPath, config) : undefined;
  const server = startGateway(config, { port, log: (l) => console.warn(l), installer: installer?.handle, enroll, manage });
  if (enroll) console.log("Adding, rotating and removing hosts from the page is on; token files go next to the config.");
  console.log(`Fleet Control client on http://127.0.0.1:${server.port}/ (${config.hosts.map((h) => h.id).join(", ") || "no hosts yet; add one at /add-host"})`);
  if (installer) {
    // The apply code must not outlive this process.
    const stop = () => { server.stop(true); void installer!.dispose().finally(() => process.exit(0)); };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
    console.log(`Installer page on http://127.0.0.1:${server.port}/install. Apply code is in the private file ${installer.codePath}`);
  }
} catch (e) {
  await installer?.dispose();
  console.error(e instanceof GatewayConfigError ? e.message : "failed to start the client gateway");
  process.exit(1);
}
