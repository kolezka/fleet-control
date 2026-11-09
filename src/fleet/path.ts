import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const pinnedFleetBin = resolve(import.meta.dir, "../../vendor/agent-fleet/scripts/fleet");

export function resolveFleetBin(env: Record<string, string | undefined> = process.env): string {
  const path = env.READONLY_FLEET_BIN ?? env.FLEET_BIN ?? pinnedFleetBin;
  if (!existsSync(path)) {
    throw new Error(`agent-fleet CLI not found at ${path}. Run git submodule update --init --recursive, or set READONLY_FLEET_BIN.`);
  }
  return path;
}
