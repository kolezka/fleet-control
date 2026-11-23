// The service settings file on disk: owner-only, replaced in one rename under the same kind of lock as the
// tokens file, and only if it still holds what the page read.
import { readFileSync } from "node:fs";
import { withLock, writeAtomic } from "../scripts/tokens.ts";
import { AuthConfigError } from "./auth.ts";
import { AdminError } from "./domain/fleet-admin.ts";
import type { SettingsFile } from "./application/settings.ts";

const readOrNull = (file: string): string | null => {
  try { return readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

export class HostSettingsFile implements SettingsFile {
  constructor(readonly path: string) {}
  async read() { return readOrNull(this.path); }
  async write(expected: string | null, text: string) {
    let wrote = false;
    try {
      withLock(this.path, () => {
        if (readOrNull(this.path) !== expected) return;
        writeAtomic(this.path, text);
        wrote = true;
      });
    } catch (e) {
      // Another change holds the lock: nothing written, the reason goes to the operator.
      if (e instanceof AuthConfigError) throw new AdminError("conflict", e.message);
      throw e;
    }
    return wrote;
  }
  // Read once at start, before anything else uses the environment.
  static readSync(file: string): string | null { return readOrNull(file); }
}

// FLEET_CONTROL_SETTINGS, else settings.json beside the tokens file.
export function settingsPath(env: Record<string, string | undefined>): string | null {
  const set = env.FLEET_CONTROL_SETTINGS?.trim();
  if (set) {
    if (!set.startsWith("/")) throw new Error("FLEET_CONTROL_SETTINGS must be an absolute path");
    return set;
  }
  const tokens = env.FLEET_CONTROL_TOKENS?.trim();
  return tokens ? tokens.replace(/[^/]*$/, "settings.json") : null;
}
