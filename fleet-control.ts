#!/usr/bin/env bun
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { parse, plan, InstallError, type Context } from "./src/install/plan.ts";
import { execute, doctor } from "./src/install/execute.ts";

export async function main(args: string[], context: Context = { code: realpathSync(import.meta.dir), bun: process.execPath, home: homedir(), platform: process.platform, uid: process.getuid!() }): Promise<number> {
  try {
    if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
      console.log("Fleet Control: doctor [--plan] | install central|adapter|client --plan|--apply. Options: --code ABS --bun ABS --config ABS --state ABS --host-id ID --port PORT --ssh USER@HOST --ssh-port PORT. No dependency bootstrap, transfer, update, restore, uninstall, status/logs or retry. Prepared checkout/private config required. Fresh central activates first local supervisor; Docker may fetch images/packages. Linux adapter requires local Docker. Plan does not connect; apply does not verify health.");
      return 0;
    }
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
