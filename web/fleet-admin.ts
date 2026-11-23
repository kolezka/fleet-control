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
  // The host's tokens file: names and roles only. null until read; absent hosts hide the part.
  tokens: TokenEntry[] | null;
  tokenName: string;
  tokenAction: "rotate" | "revoke";
  tokenConfirm: string;
  // A rotated token, shown once until the operator dismisses it or picks another host.
  newToken: string;
  // This gateway's own link to the host: rotate its token or remove the host.
  hostConfirm: string;
  hostRevoke: boolean;
  // The service settings file: null until read; hosts without it hide the part.
  settings: SettingsRead | null;
  settingsDraft: SettingsDraft;
  settingsConfirm: string;
  // The host's reason the settings file cannot be read (broken by hand); the part shows it.
  settingsError: string;
  // An unsaved edit whose file changed on the host since; Reload takes the new file.
  settingsChangedOnHost: boolean;
};

export type SettingsValues = { agentRoots: string[]; agentModels: string[]; agentDshModels: string[]; agentMcpUrl: string | null; input: boolean };
export type SettingsRead = { path: string; revision: string; running: SettingsValues; next: SettingsValues; restartNeeded: string[]; skipped: string | null };
// One text field per list (one entry per line), as typed.
export type SettingsDraft = { agentRoots: string; agentModels: string; agentDshModels: string; agentMcpUrl: string; input: boolean };

export type TokenEntry = { name: string; role: string; self: boolean; managed: boolean };

export const emptyAdmin = (): AdminView => ({
  status: "idle", error: "", conf: null, changedOnHost: false, draft: "", saveConfirm: "", logSource: "watchdog", logText: "",
  restartSession: "", restartConfirm: "", busy: false, notice: "",
  tokens: null, tokenName: "", tokenAction: "rotate", tokenConfirm: "", newToken: "", hostConfirm: "", hostRevoke: true,
  settings: null, settingsDraft: { agentRoots: "", agentModels: "", agentDshModels: "", agentMcpUrl: "", input: false }, settingsConfirm: "", settingsError: "", settingsChangedOnHost: false,
});

const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((y) => typeof y === "string");
const values = (x: unknown): SettingsValues | null => {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (!strings(o.agentRoots) || !strings(o.agentModels) || !strings(o.agentDshModels) || !(typeof o.agentMcpUrl === "string" || o.agentMcpUrl === null) || typeof o.input !== "boolean") return null;
  return { agentRoots: o.agentRoots, agentModels: o.agentModels, agentDshModels: o.agentDshModels, agentMcpUrl: o.agentMcpUrl as string | null, input: o.input };
};

export function parseSettings(body: unknown): SettingsRead | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const running = values(o.running), next = values(o.next);
  if (typeof o.path !== "string" || typeof o.revision !== "string" || !running || !next || !strings(o.restartNeeded)) return null;
  return { path: o.path, revision: o.revision, running, next, restartNeeded: o.restartNeeded, skipped: typeof o.skipped === "string" ? o.skipped : null };
}

export const draftOf = (s: SettingsValues): SettingsDraft => ({
  agentRoots: s.agentRoots.join("\n"), agentModels: s.agentModels.join("\n"), agentDshModels: s.agentDshModels.join("\n"), agentMcpUrl: s.agentMcpUrl ?? "", input: s.input,
});

const lines = (t: string) => t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
// What the page sends: every setting. The host keeps in the file only those that differ from its plist or unit.
export const settingsBody = (d: SettingsDraft) => ({
  agentRoots: lines(d.agentRoots), agentModels: lines(d.agentModels), agentDshModels: lines(d.agentDshModels), agentMcpUrl: d.agentMcpUrl.trim() || null, input: d.input,
});

export function settingsGate(v: AdminView): { ok: boolean; reason: string } {
  if (v.busy) return { ok: false, reason: "Working…" };
  if (!v.settings) return { ok: false, reason: "Read the settings first" };
  if (v.settingsChangedOnHost) return { ok: false, reason: "The settings file changed on the host; copy your edit, then Reload" };
  if (JSON.stringify(settingsBody(v.settingsDraft)) === JSON.stringify(settingsBody(draftOf(v.settings.next)))) return { ok: false, reason: "No changes" };
  if (v.settingsConfirm !== "settings") return { ok: false, reason: "Type settings to confirm" };
  return { ok: true, reason: "Saved to the settings file; the service takes it at its next start" };
}

export function parseTokens(body: unknown): TokenEntry[] | null {
  const list = body && typeof body === "object" ? (body as { tokens?: unknown }).tokens : undefined;
  if (!Array.isArray(list)) return null;
  const out: TokenEntry[] = [];
  for (const t of list) {
    if (!t || typeof t !== "object") return null;
    const r = t as Record<string, unknown>;
    if (!str(r.name) || !str(r.role) || typeof r.self !== "boolean" || typeof r.managed !== "boolean") return null;
    out.push({ name: r.name, role: r.role, self: r.self, managed: r.managed });
  }
  return out;
}

// The lines the page may change: not this gateway's own (that goes through the gateway) and not managed agents'.
export const changeable = (tokens: TokenEntry[] | null): TokenEntry[] => (tokens ?? []).filter((t) => !t.self && !t.managed);

export function tokenGate(v: AdminView): { ok: boolean; reason: string } {
  if (v.busy) return { ok: false, reason: "Working…" };
  const t = changeable(v.tokens).find((x) => x.name === v.tokenName);
  if (!t) return { ok: false, reason: "Choose a token" };
  if (v.tokenAction === "revoke" && t.role === "operator" && (v.tokens ?? []).filter((x) => x.role === "operator").length < 2) {
    return { ok: false, reason: `${t.name} is the last operator` };
  }
  if (v.tokenConfirm !== t.name) return { ok: false, reason: `Type ${t.name} to confirm` };
  return { ok: true, reason: v.tokenAction === "rotate" ? `${t.name} gets a new token; the old one stops at once` : `${t.name} stops working at once` };
}

export function hostGate(v: AdminView, hostId: string): { ok: boolean; reason: string } {
  if (v.busy) return { ok: false, reason: "Working…" };
  if (v.hostConfirm !== hostId) return { ok: false, reason: `Type ${hostId} to confirm` };
  return { ok: true, reason: "" };
}

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
