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
  // The host's restartable sessions with saved start commands; null where the host does not offer them.
  sessions: SessionRow[] | null;
  // The start command form for the chosen session, pre-filled from the saved command or tmux.
  startFor: string;
  startCommand: string;
  startCwd: string;
  startConfirm: string;
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
  // agent-fleet's watchdog as a host service: null until read; hosts without it hide the part.
  watchdog: WatchdogRead | null;
  watchdogConfirm: string;
};

export type SessionRow = { session: string; inConf: boolean; running: boolean; saved: { command: string; cwd: string; savedBy: string; savedAt: string } | null; pane: { command: string | null; cwd: string } | null };
export type SettingsValues = { agentRoots: string[]; agentModels: string[]; agentDshModels: string[]; agentMcpUrl: string | null; input: boolean };
// saved: the keys the file holds; base: the plist's or unit's values.
export type SettingsRead = { path: string; revision: string; running: SettingsValues; next: SettingsValues; base: SettingsValues; saved: string[]; restartNeeded: string[]; skipped: string | null };
// One text field per list (one entry per line), as typed.
export type SettingsDraft = { agentRoots: string; agentModels: string; agentDshModels: string; agentMcpUrl: string; input: boolean };

export type WatchdogRead = { fleet: string; manager: "launchd" | "systemd" | null; name: string; installed: boolean; running: boolean; pid: number | null; inTmux: boolean };

export function parseWatchdog(x: unknown): WatchdogRead | null {
  if (!x || typeof x !== "object") return null;
  const w = x as Record<string, unknown>;
  if (typeof w.fleet !== "string" || typeof w.name !== "string" || typeof w.installed !== "boolean" || typeof w.running !== "boolean" || typeof w.inTmux !== "boolean") return null;
  if (w.manager !== "launchd" && w.manager !== "systemd" && w.manager !== null) return null;
  if (w.pid !== null && typeof w.pid !== "number") return null;
  return { fleet: w.fleet, manager: w.manager, name: w.name, installed: w.installed, running: w.running, pid: w.pid as number | null, inTmux: w.inTmux };
}

// The one button turns the service on when it is off and off when it is on.
export function watchdogGate(v: AdminView): { ok: boolean; on: boolean; reason: string } {
  const w = v.watchdog;
  if (!w) return { ok: false, on: false, reason: "Read the watchdog first" };
  const on = !w.running;
  if (!w.manager) return { ok: false, on, reason: "This host has neither launchd nor systemd" };
  if (on && w.inTmux) return { ok: false, on, reason: `A watchdog runs in tmux session ${w.fleet}-watchdog; stop it with fleet watchdog stop first` };
  if (v.busy) return { ok: false, on, reason: "Working" };
  if (v.watchdogConfirm !== "watchdog") return { ok: false, on, reason: "Type watchdog to confirm" };
  return { ok: true, on, reason: on ? `Starts ${w.name} now and at every login` : `Stops ${w.name}; agents keep running` };
}

export type TokenEntry = { name: string; role: string; self: boolean; managed: boolean };

export const emptyAdmin = (): AdminView => ({
  status: "idle", error: "", conf: null, changedOnHost: false, draft: "", saveConfirm: "", logSource: "watchdog", logText: "",
  restartSession: "", restartConfirm: "", sessions: null, startFor: "", startCommand: "", startCwd: "", startConfirm: "", busy: false, notice: "",
  tokens: null, tokenName: "", tokenAction: "rotate", tokenConfirm: "", newToken: "", hostConfirm: "", hostRevoke: true,
  settings: null, settingsDraft: { agentRoots: "", agentModels: "", agentDshModels: "", agentMcpUrl: "", input: false }, settingsConfirm: "", settingsError: "", settingsChangedOnHost: false,
  watchdog: null, watchdogConfirm: "",
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
  const saved = o.saved && typeof o.saved === "object" && !Array.isArray(o.saved) ? Object.keys(o.saved) : [];
  return { path: o.path, revision: o.revision, running, next, base: values(o.base) ?? next, saved, restartNeeded: o.restartNeeded, skipped: typeof o.skipped === "string" ? o.skipped : null };
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
  if (v.settingsChangedOnHost) return { ok: false, reason: "The settings file changed on the host; copy your edit, then Reload the settings" };
  const body = settingsBody(v.settingsDraft);
  const drops = v.settings.saved.some((k) => JSON.stringify(body[k as keyof typeof body]) === JSON.stringify(v.settings!.base[k as keyof SettingsValues]));
  if (JSON.stringify(body) === JSON.stringify(settingsBody(draftOf(v.settings.next))) && !drops) return { ok: false, reason: "No changes" };
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

// Managed agents are not offered: they are restarted from the agent list. A host that lists its sessions
// (fleet.conf, its tmux server, saved starts) gives that list; an older host gives fleet.conf only.
export const restartable = (conf: ConfRead | null, sessions: SessionRow[] | null = null): string[] =>
  (sessions ? sessions.map((r) => r.session) : conf?.sessions ?? []).filter((s) => !s.startsWith("fc-"));

export function parseRestartable(body: unknown): SessionRow[] | null {
  const list = body && typeof body === "object" ? (body as { sessions?: unknown; starts?: unknown }) : undefined;
  if (!list || list.starts !== true || !Array.isArray(list.sessions)) return null;
  const cmd = (x: unknown) => (x && typeof x === "object" && str((x as Record<string, unknown>).command) && str((x as Record<string, unknown>).cwd) ? x as { command: string; cwd: string } : null);
  const rows: SessionRow[] = [];
  for (const r of list.sessions as unknown[]) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    if (!str(o.session) || typeof o.inConf !== "boolean" || typeof o.running !== "boolean") return null;
    const saved = cmd(o.saved);
        const p = o.pane && typeof o.pane === "object" ? o.pane as Record<string, unknown> : null;
    const pane = p && str(p.cwd) && (str(p.command) || p.command === null) ? { command: p.command as string | null, cwd: p.cwd as string } : null;
    rows.push({ session: o.session, inConf: o.inConf, running: o.running, pane,
      saved: saved ? { command: saved.command, cwd: saved.cwd, savedBy: str((o.saved as Record<string, unknown>).savedBy) ? (o.saved as { savedBy: string }).savedBy : "", savedAt: str((o.saved as Record<string, unknown>).savedAt) ? (o.saved as { savedAt: string }).savedAt : "" } : null });
  }
  return rows;
}

// Points the start form at the chosen session, filled from its saved command, else from what tmux reports.
export function fillStart(v: AdminView): void {
  if (v.startFor === v.restartSession) return;
  const row = v.sessions?.find((r) => r.session === v.restartSession);
  // A pane whose command tmux showed with escapes the page cannot read back fills nothing in.
  const from = row?.saved ?? (row?.pane?.command == null ? null : row.pane);
  v.startFor = v.restartSession;
  v.startCommand = from?.command ?? "";
  v.startCwd = from?.cwd ?? "";
  v.startConfirm = "";
}

export function startCommandGate(v: AdminView): { ok: boolean; reason: string } {
  if (v.busy) return { ok: false, reason: "Working…" };
  const row = v.sessions?.find((r) => r.session === v.restartSession);
  if (!row) return { ok: false, reason: "Choose a session" };
  if (row.inConf) return { ok: false, reason: `${row.session} starts from fleet.conf` };
  if (!v.startCwd.startsWith("/")) return { ok: false, reason: "The folder must be an absolute path" };
  if (row.saved && row.saved.command === v.startCommand.trim() && row.saved.cwd === v.startCwd) return { ok: false, reason: "Saved" };
  if (v.startConfirm !== row.session) return { ok: false, reason: `Type ${row.session} to confirm` };
  return { ok: true, reason: v.startCommand.trim() ? "Restart runs this command in this folder" : "Restart opens the default shell in this folder" };
}

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
  if (!v.restartSession || !restartable(v.conf, v.sessions).includes(v.restartSession)) return { ok: false, reason: "Choose a session" };
  const row = v.sessions?.find((r) => r.session === v.restartSession);
  if (row && !row.saved && !row.inConf) return { ok: false, reason: `Save a start command for ${row.session} first` };
  if (v.restartConfirm !== v.restartSession) return { ok: false, reason: `Type ${v.restartSession} to confirm` };
  return { ok: true, reason: row?.saved && !row.inConf ? `Ends ${v.restartSession} and starts it again with its saved command` : `Ends ${v.restartSession} and starts it again from fleet.conf` };
}
