// The page's fleet section: fleet.conf, logs and restarting one session. Pure state and rules; app.ts draws it.

export type ConfRead = { path: string; text: string; revision: string; sessions: string[]; loadError: string | null };
export type AdminView = {
  status: "idle" | "loading" | "ready" | "absent" | "unknown";
  error: string;
  // The file the draft was made from; it changes only on Reload or a successful save.
  conf: ConfRead | null;
  // Set when a later read found a different file while the draft had unsaved changes.
  changedOnHost: boolean;
  draft: string;
  saveConfirm: string;
  logSource: "watchdog" | "service";
  logText: string;
  restartSession: string;
  restartConfirm: string;
  busy: boolean;
  notice: string;
};

export const emptyAdmin = (): AdminView => ({
  status: "idle", error: "", conf: null, changedOnHost: false, draft: "", saveConfirm: "", logSource: "watchdog", logText: "",
  restartSession: "", restartConfirm: "", busy: false, notice: "",
});

const str = (v: unknown): v is string => typeof v === "string";
export function parseConf(body: unknown): ConfRead | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!str(b.path) || !str(b.text) || !str(b.revision) || !Array.isArray(b.sessions) || !b.sessions.every(str)) return null;
  return { path: b.path, text: b.text, revision: b.revision, sessions: b.sessions as string[], loadError: str(b.loadError) ? b.loadError : null };
}

// Managed agents are not offered: they are restarted from the agent list.
export const restartable = (conf: ConfRead | null): string[] => (conf?.sessions ?? []).filter((s) => !s.startsWith("fc-"));

export function saveGate(v: AdminView): { ok: boolean; reason: string } {
  if (v.busy) return { ok: false, reason: "Working…" };
  if (!v.conf) return { ok: false, reason: "Read fleet.conf first" };
  if (v.changedOnHost) return { ok: false, reason: "fleet.conf changed on the host; copy your edit, then Reload" };
  if (v.draft === v.conf.text) return { ok: false, reason: "No changes" };
  if (v.saveConfirm !== "fleet.conf") return { ok: false, reason: "Type fleet.conf to confirm" };
  return { ok: true, reason: "Save keeps a backup of the current file" };
}

export function restartGate(v: AdminView): { ok: boolean; reason: string } {
  if (v.busy) return { ok: false, reason: "Working…" };
  if (!v.restartSession || !restartable(v.conf).includes(v.restartSession)) return { ok: false, reason: "Choose a session" };
  if (v.restartConfirm !== v.restartSession) return { ok: false, reason: `Type ${v.restartSession} to confirm` };
  return { ok: true, reason: `Ends ${v.restartSession} and starts it again from fleet.conf` };
}
