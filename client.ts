// MacBook client gateway entry. Loopback only; holds host tokens server-side and relays to each
// host's own Fleet Control service. Config: FLEET_CONTROL_CLIENT_CONFIG or the first CLI argument.
import { GatewayConfigError, loadGatewayConfig, startGateway } from "./src/client-gateway.ts";
import { createInstaller, localContext } from "./src/install/web.ts";

const configPath = process.argv[2] ?? process.env.FLEET_CONTROL_CLIENT_CONFIG;
if (!configPath) {
  console.error("usage: bun client.ts <config.json>  (or set FLEET_CONTROL_CLIENT_CONFIG)");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 4870);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("PORT must be an integer between 0 and 65535");
  process.exit(1);
}

let installer: Awaited<ReturnType<typeof createInstaller>> | undefined;
try {
  const config = await loadGatewayConfig(configPath);
  // Off unless asked for. Installed services do not set this.
  if (process.env.FLEET_CONTROL_INSTALLER === "1") installer = await createInstaller(localContext());
  const server = startGateway(config, { port, log: (l) => console.warn(l), installer: installer?.handle });
  console.log(`Fleet Control client on http://127.0.0.1:${server.port}/ (${config.hosts.map((h) => h.id).join(", ")})`);
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
