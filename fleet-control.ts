#!/usr/bin/env bun
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { parse, plan, InstallError, type Context } from "./src/install/plan.ts";
import { execute, doctor } from "./src/install/execute.ts";

// Loopback installer page with no hosts configured. The apply code is written to a private file, never printed.
async function ui(args: string[], context: Context): Promise<number> {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--port" || !/^[1-9][0-9]{0,4}$/.test(args[1]!) || Number(args[1]) > 65535)) throw new InstallError("usage: ui [--port PORT]");
  const { Credentials, startGateway } = await import("./src/client-gateway.ts");
  const { createInstaller } = await import("./src/install/web.ts");
  const installer = await createInstaller(context);
  let server;
  try { server = startGateway({ hosts: [], credentials: new Credentials(new Map()) }, { port: Number(args[1] ?? 4880), installer: installer.handle }); }
  catch { await installer.dispose(); throw new InstallError("cannot listen on the requested loopback port"); }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.stop(true); void installer.dispose().finally(() => process.exit(0)); });
  console.log("Installer page on http://127.0.0.1:" + server.port + "/install (loopback only). Apply code is in the private file " + installer.codePath + ". Stop with Ctrl-C.");
  return 0;
}

export async function main(args: string[], context: Context = { code: realpathSync(import.meta.dir), bun: process.execPath, home: homedir(), platform: process.platform, uid: process.getuid!() }): Promise<number> {
  try {
    if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
      console.log("Fleet Control: doctor [--plan] | install central|adapter|client|waker --plan|--apply | ui [--port PORT]. Options: --code ABS --bun ABS --config ABS --state ABS --host-id ID --port PORT --ssh USER@HOST --ssh-port PORT. No dependency bootstrap, transfer, update, restore, uninstall, status/logs or retry. Prepared checkout/private config required. Fresh central activates first local supervisor; Docker may fetch images/packages. Linux adapter requires local Docker. Plan does not connect; apply does not verify health.");
      return 0;
    }
    if (args[0] === "ui") return await ui(args.slice(1), context);
    const options = parse(args, context);
    const proposed = plan(options, context);
    if (options.command === "doctor" && !args.includes("--plan")) console.log(await doctor(proposed));
    else if (options.apply) console.log(await execute(proposed));
    else console.log(JSON.stringify(proposed, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof InstallError ? error.message : "install prerequisite or configuration check failed; details suppressed");
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
