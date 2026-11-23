// Service settings from the page. They are written to a settings file and take effect when the service
// starts again; the running service keeps the values it started with, and the answer says which differ.
import { createHash } from "node:crypto";
import { AdminError } from "../domain/fleet-admin.ts";
import { requirePermission, type Caller } from "../domain/roles.ts";
import { checkNeedsRoots, checkSettings, settingsDiff, settingsEnv, settingsOf, SETTINGS_CONFIRM, type ServiceSettings } from "../domain/settings.ts";

export type SettingsFile = {
  path: string;
  // The file's text, or null when there is none yet.
  read(): Promise<string | null>;
  // Writes the text in one rename if the file still has the text it was read with (null: still absent).
  // Returns false when it changed in between, and writes nothing then.
  write(expected: string | null, text: string): Promise<boolean>;
};

export type SettingsDeps = {
  file: SettingsFile;
  // The environment from the plist or unit, before the file was applied.
  baseEnv: Record<string, string | undefined>;
  // The settings the running service started with.
  running: Required<ServiceSettings>;
  // Throws when the service would not start with this environment, or would start without part of it
  // (the same checks index.ts runs at start).
  check(env: Record<string, string | undefined>): Promise<void>;
  // Why the file was skipped at this start, or null when it was taken (or absent).
  skipped?: string | null;
};

// No file has its own revision, so it never equals the revision of an empty file.
export const settingsRevision = (text: string | null) => (text === null ? "0".repeat(64) : createHash("sha256").update(text).digest("hex"));

export function parseSettingsFile(text: string | null): ServiceSettings {
  if (text === null) return {};
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new AdminError("invalid", "the settings file is not JSON; fix or remove it on the host"); }
  try { return checkSettings(raw); } catch (e) {
    throw new AdminError("invalid", `the settings file is not valid (${e instanceof Error ? e.message : e}); fix or remove it on the host`);
  }
}

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(run: () => Promise<T>): Promise<T> => { const next = chain.then(run, run); chain = next.catch(() => undefined); return next; };

export function settingsUseCases(deps: SettingsDeps, caller?: Caller) {
  const view = (text: string | null) => {
    const saved = parseSettingsFile(text);
    const next = settingsOf(settingsEnv(deps.baseEnv, saved));
    const differs = (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(deps.running[k]));
    return { path: deps.file.path, revision: settingsRevision(text), saved, base: settingsOf(deps.baseEnv), running: deps.running, next, restartNeeded: differs, skipped: deps.skipped ?? null };
  };
  return {
    async get() {
      requirePermission(caller, "operate");
      return view(await deps.file.read());
    },
    async save(input: unknown) {
      requirePermission(caller, "operate");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminError("invalid", "body must be an object");
      const { settings, revision, confirm, ...rest } = input as Record<string, unknown>;
      const extra = Object.keys(rest);
      if (extra.length) throw new AdminError("invalid", `unknown field ${extra[0]}`);
      if (typeof revision !== "string" || !/^[0-9a-f]{64}$/.test(revision)) throw new AdminError("invalid", "revision must be the 64-hex revision the settings were read at");
      if (confirm !== SETTINGS_CONFIRM) throw new AdminError("invalid", `type ${SETTINGS_CONFIRM} to confirm`);
      // The page sends every setting; the file keeps only those that differ from the plist or unit.
      const full = settingsOf(settingsEnv(deps.baseEnv, checkSettings(settings)));
      const next = settingsDiff(settingsOf(deps.baseEnv), full);
      checkNeedsRoots(full, next);
      // A file the service could not start with would take the page down at the next restart.
      try { await deps.check(settingsEnv(deps.baseEnv, next)); } catch (e) {
        throw new AdminError("invalid", `the service would not start with these settings: ${e instanceof Error ? e.message : e}`);
      }
      return serial(async () => {
        const current = await deps.file.read();
        if (settingsRevision(current) !== revision) throw new AdminError("conflict", "the settings file changed on the host since you read it; reload and edit again");
        const text = `${JSON.stringify(next, null, 2)}\n`;
        if (!(await deps.file.write(current, text))) throw new AdminError("conflict", "the settings file changed on the host during the save; nothing was written. Reload and edit again");
        return view(text);
      });
    },
  };
}
export type SettingsUseCases = ReturnType<typeof settingsUseCases>;
