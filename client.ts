// MacBook client gateway entry. Loopback only; holds host tokens server-side and relays to each
// host's own Fleet Control service. Config: FLEET_CONTROL_CLIENT_CONFIG or the first CLI argument.
import { GatewayConfigError, loadGatewayConfig, startGateway } from "./src/client-gateway.ts";

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

try {
  const config = await loadGatewayConfig(configPath);
  const server = startGateway(config, { port, log: (l) => console.warn(l) });
  console.log(`Fleet Control client on http://127.0.0.1:${server.port}/ (${config.hosts.map((h) => h.id).join(", ")})`);
} catch (e) {
  console.error(e instanceof GatewayConfigError ? e.message : "failed to start the client gateway");
  process.exit(1);
}
