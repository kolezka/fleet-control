/// <reference lib="dom" />
// Live Terminal Deck: hosts with nested sessions on the left, the selected host's read-only panes in the
// centre, the selected host's supervisor panel on the right. Every host is read and written through its
// own base path (`/api` for a single host service, `/api/hosts/<id>` through a gateway) and has its own
// state in web/host-state.ts. Keys reach a session only while this pane's socket holds the host's input lease (web/lease.ts).
import { init, Terminal } from "ghostty-web";
import { CONFIRM_MS, leaseButton, leaseStatus, mayType, noLease, onControlFrame, onLeaseAnswer, onLeaseClick, type LeaseView } from "./lease.ts";
import {
  type Command, type CommandIntent, type Fleet, type HostInfo, type HostState, type Model, type Outcome, type Peer, type ReadKind, type Req, type Session,
  beginPageRead, finishPageRead, parseCommandPage, parseInspection, selectCommand, isCommand,
  answerKey, beginAnswer, beginRead, beginSend, classifySend, composerTarget, currentRun, describeSessions, emptyFleet, finishAnswer, finishRead, finishSend,
  interpretResponse, paneKey, parseCoord, terminalClosedText, parseHostList, parseSessions, selectHost, selectSession, selectedHostState, sendGate, setDraft, setHosts,
} from "./host-state.ts";
import { type AdminView, changeable, moveGate, parseMove, draftOf, emptyAdmin, fileDirty, fileGate, fileName, fillStart, hostGate, infraGate, parentIn, parseConf, parseFileOpen, parseFileRoots, parseInfra, parseRestartable, parseService, parseSettings, parseTokens, parseWatchdog, restartable, restartGate, saveGate, serviceGate, serviceWord, settingsBody, settingsGate, startCommandGate, tokenGate, watchdogGate } from "./fleet-admin.ts";
import { type AgentForm, type AgentKind, type AgentList, KIND_LABEL, agentStateText, canStop, kindsOf, modelsFor, parseAgents, settling, startGate } from "./agents.ts";

import { applyAppearance, preferenceOptions, readPreferences, savePreferences, type Preference } from "./studio-prefs.ts";

import { navigationMarkup } from "./studio-navigation.ts";

const $ = (id: string) => document.getElementById(id)!;
$('studioNavigation').innerHTML = navigationMarkup;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function modelLabel(m: Model): string {
  switch (m.state) {
    case "observed": return `Model ${m.model}`;
    case "configured": return `Configured ${m.model}, not observed`;
    case "unknown": return m.lastObserved ? `Model unknown, last seen ${m.lastObserved.model}` : "Model unknown";
    case "not_applicable": return "No model (script)";
  }
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Full provenance for the label's title and screen readers.
export function modelDetail(m: Model): string {
  switch (m.state) {
    case "observed": return `${m.model}, ${m.source ?? "observed"}${m.observedAt ? `, last main-thread turn ${hhmm(m.observedAt)}` : ""}`;
    case "configured": return `Configured ${m.model}. No runtime observation for this session.`;
    case "unknown": return [m.reason ?? "No current observation", m.lastObserved ? `Last observed ${m.lastObserved.model} at ${hhmm(m.lastObserved.observedAt)}, not current` : ""].filter(Boolean).join(". ");
    case "not_applicable": return "Script session, does not use a model";
  }
}

const READ_TIMEOUT_MS = 8000;
const WRITE_TIMEOUT_MS = 15000;
// An update downloads, backs up, starts a scratch copy and swaps; ten minutes covers it with room.
const SERVICE_POLL_MS = 3000;
const SERVICE_POLLS = 200;
// The gateway waits 60 s for restart and update (the host asks GitHub for releases and the tag first).
const SERVICE_TIMEOUT_MS = 65000;
// A read of /service may wait on a cold release list (the host gives GitHub 20 s).
const SERVICE_READ_TIMEOUT_MS = 30000;
// The gateway gives a watchdog start 60 s; the page waits a little longer.
const WATCHDOG_TIMEOUT_MS = 65000;
// The gateway gives a renewal or a service restart 190 s; the page waits a little longer.
const INFRA_TIMEOUT_MS = 195000;
const SHOWN_COMMANDS = 6;

// One call to one host. A 401 from a single host service means this page has no sign-in: go to /login.
// Through a gateway a 401 is that upstream host's answer, so it only makes that host unknown.
async function hostCall(host: HostInfo, path: string, init: RequestInit = {}, timeoutMs = READ_TIMEOUT_MS): Promise<{ status: number | null; outcome: Outcome<unknown>; kind?: string }> {
  try {
    const res = await fetch(`${host.apiBase}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 && host.direct) location.assign("./login");
    const body = await res.json().catch(() => null);
    const kind = (body as { error?: { kind?: unknown } } | null)?.error?.kind;
    return { status: res.status, outcome: interpretResponse(res.status, body), ...(typeof kind === "string" ? { kind } : {}) };
  } catch (e) {
    return { status: null, outcome: { ok: false, kind: "network", message: e instanceof Error && e.name === "TimeoutError" ? "No answer in time" : "Unreachable" } };
  }
}

let fleet: Fleet = emptyFleet();
let mode: "gateway" | "direct" | "" = "";
let peers: Peer[] = [];
let hostListError = "";
let installer = false;
let enroll = false;
// The gateway can rotate its own token for a host and remove a host.
let manage = false;
let inspectorOpen = false;
const apply = (f: Fleet) => { fleet = f; };

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// A workspace theme override must not change the palette of newly opened terminal panes.
const terminalPalette = { background: '#181b1f', foreground: '#d9dde4', cursor: '#959da9' };

// Replaces markup only when it changed, and puts keyboard focus back on the same control (data-fk).
const lastHtml = new WeakMap<HTMLElement, string>();
function setHtml(el: HTMLElement, html: string) {
  if (lastHtml.get(el) === html) return;
  const fk = (document.activeElement as HTMLElement | null)?.dataset?.fk;
  const had = fk !== undefined && el.contains(document.activeElement);
  el.innerHTML = html;
  lastHtml.set(el, html);
  if (had) (el.querySelector(`[data-fk="${CSS.escape(fk!)}"]`) as HTMLElement | null)?.focus();
}

const HOST_ICON = `<span class="hosticon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 20h8m-4-3v3"/></svg></span>`;
const plural = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;
const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : "");

function hostSubtitle(h: HostState): string {
  const v = describeSessions(h);
  if (v.kind === "loading") return "Reading sessions";
  if (v.kind === "ready") return plural(v.count);
  return v.lastKnownCount === null ? "State unknown" : `State unknown · last known ${plural(v.lastKnownCount)}`;
}

const collapsedGroups = new Set<string>();
const hostDisclosures = new Map<string, boolean>();
function renderNav() {
  const byGroup = new Map<string, string[]>();
  for (const id of fleet.order) {
    const group = fleet.hosts[id]!.info.group ?? "Ungrouped";
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push(id);
  }
  const renderHost = (id: string) => {
    const h = fleet.hosts[id]!;
    const here = id === fleet.selectedHost;
    const unknown = h.sessionsRead.status === "unknown";
    const rows = h.sessions.map((s) => {
      const status = unknown
        ? `State unknown · last known ${s.running ? "running" : "not running"}`
        : `${s.running ? "Running" : "Not running"} · ${modelLabel(s.model)}`;
      const title = unknown ? "The host could not be read; this is the last known state" : modelDetail(s.model);
      return `<button type="button" class="session" data-fk="s:${esc(id)}:${esc(s.name)}" data-host="${esc(id)}" data-session="${esc(s.name)}" aria-pressed="${here && h.selectedSession === s.name}"><span class="dot ${s.running && !unknown ? "good" : ""}"></span><span><strong>${esc(s.name)}</strong><small title="${esc(title)}">${esc(status)}</small></span></button>`;
    }).join("");
    const expanded = hostDisclosures.get(id) ?? (here && preferences.groups !== 'collapsed');
    const count = h.sessionsRead.status === 'ready' ? String(h.sessions.length) : '?';
    return `<section class="hostgroup" aria-label="${esc(h.info.name)}"><div class="studio-host-row"><button type="button" class="host-disclosure" data-fk="expand:${esc(id)}" data-toggle-host="${esc(id)}" aria-label="${expanded ? 'Collapse' : 'Expand'} ${esc(h.info.name)}" aria-expanded="${expanded}">${expanded ? '▾' : '▸'}</button><button type="button" class="hostbutton" data-fk="h:${esc(id)}" data-host="${esc(id)}" title="${esc(h.info.name)} · ${esc(hostSubtitle(h))}" aria-pressed="${here && studioView === 'machine'}">${HOST_ICON}<span class="hostidentity"><strong>${esc(h.info.name)}</strong></span><small aria-label="${esc(hostSubtitle(h))}">${count}</small></button></div>${expanded ? `<div class="host-sessions">${rows}</div>` : ''}</section>`;
  };
  const groups = Array.from(byGroup, ([group, ids]) => {
    const expanded = !collapsedGroups.has(group), name = esc(group);
    return `<section class="studio-host-group"><h3><button type="button" data-fk="group:${name}" data-toggle-group="${name}" aria-expanded="${expanded}"><span aria-hidden="true">${expanded ? '▾' : '▸'}</span> ${name} (${ids.length})</button></h3>${expanded ? ids.map(renderHost).join("") : ""}</section>`;
  }).join("");
  // A single host service only links to other hosts' own services; it never reads their sessions.
  const peerLinks = peers.map((p) => `<section class="hostgroup peer" aria-label="${esc(p.name)}"><a class="hostbutton" href="${esc(p.url)}" target="_blank" rel="noopener">${HOST_ICON}<span class="hostidentity"><strong>${esc(p.name)}</strong><small>Own service · open</small></span></a></section>`).join("");
  const enrollLink = mode === 'gateway' && enroll ? '<a class="tree-action" href="./add-host" aria-label="Add a host" title="Add a host">+</a>' : '';
  const editLink = mode === 'gateway' && manage && fleet.selectedHost ? `<a class="tree-action" href="./workstation?host=${encodeURIComponent(fleet.selectedHost)}" aria-label="Edit selected workstation" title="Edit selected workstation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16l11-11 4 4L8 20H4z M13 7l4 4"/></svg></a>` : '';
  const installLink = mode === 'gateway' && installer ? '<div class="sidebarfoot"><a class="footlink" href="./install">Install on this machine</a></div>' : '';
  setHtml($('sidebar'), `<div class="sidebarhead"><span>Host tree</span>${enrollLink}${editLink}</div>${groups}${peerLinks}${installLink}`);
}

const SIZE_HINT = /\x1b\]777;fleet-size;(\d+);(\d+)\x07/;

// The terminal is created at the agent window size announced by agent-fleet, so it never needs a
// resize of the agent window. After an unexpected close the pane reconnects with backoff; a new
// tmux attach redraws the whole screen, so the old terminal is replaced, not appended to.
type Pane = { stop(): void; setFontSize(size: number): void };
const preferences = readPreferences();
applyAppearance(document.documentElement, preferences);
let draftPrefs = { ...preferences };
let preferenceStatus = 'No pending changes';
const preferencesDirty = () => (Object.keys(preferences) as Preference[]).some(key => preferences[key] !== draftPrefs[key]);
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];


function openPane(s: Session, el: HTMLElement, host: HostInfo): Pane {
  const status = el.closest(".terminal")!.querySelector(".termstate")!;
  let term: Terminal | null = null;
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const art = el.closest(".terminal")!;
  const button = art.querySelector(".typebtn") as HTMLButtonElement | null;
  let lease: LeaseView = noLease;
  let viewerStatus = "Connecting";
  let lapse: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  const enc = new TextEncoder();
  // Every lease change goes through here: button, status line, and whether the terminal takes keys.
  const show = (next: LeaseView) => {
    lease = next;
    const b = leaseButton(lease, s.name);
    if (button) {
      button.hidden = b.hidden;
      button.textContent = b.label;
      button.disabled = b.disabled;
      button.classList.toggle("danger", b.danger);
    }
    art.classList.toggle("typing", mayType(lease));
    if (term) term.options.disableStdin = !mayType(lease);
    if (mayType(lease)) term?.focus();
    clearInterval(tick);
    if (mayType(lease)) tick = setInterval(() => show(lease), 30_000);
    status.textContent = leaseStatus(lease, new Date()) ?? viewerStatus;
  };
  const setStatus = (t: string) => { viewerStatus = t; status.textContent = leaseStatus(lease, new Date()) ?? t; };
  const ask = async () => {
    clearTimeout(lapse);
    const step = onLeaseClick(lease);
    show(step.view);
    if (step.view.state === "confirm") lapse = setTimeout(() => { if (lease.state === "confirm") show({ ...lease, state: "off" }); }, CONFIRM_MS);
    const r = step.request;
    if (!r) return;
    const url = `${host.apiBase}/sessions/${encodeURIComponent(s.name)}/lease`;
    try {
      const res = await fetch(url, r.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r.body) } : { method: "DELETE" });
      let body: unknown = null;
      try { body = await res.json(); } catch { /* no body */ }
      show(onLeaseAnswer(lease, r.method, res.status, body));
    } catch {
      show(onLeaseAnswer(lease, r.method, 0, null));
    }
  };
  if (button) button.onclick = () => { void ask(); };

  const connect = () => {
    // A host service also takes the session as a query, which a prefix proxy can route on one path.
    const path = host.direct ? `${host.apiBase}/terminal?session=${encodeURIComponent(s.name)}&cols=80&rows=24` : `${host.apiBase}/sessions/${encodeURIComponent(s.name)}/terminal?cols=80&rows=24`;
    const url = new URL(path, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(url);
    ws = sock;
    sock.binaryType = "arraybuffer";
    const dec = new TextDecoder();
    let pending = "";
    let fresh = true;
    // A host over its viewer cap accepts the socket and closes it at once, so "live" waits for output.
    show(noLease);
    sock.onopen = () => { setStatus("Read-only · connected, waiting for output"); };
    sock.onmessage = (e) => {
      // Text frames are the host's lease messages; terminal output is always binary.
      if (typeof e.data === "string") {
        if (sock === ws && !stopped) show(onControlFrame(lease, e.data));
        return;
      }
      if (sock === ws && !stopped) setStatus(mayType(lease) ? "Typing · live" : "Read-only · live");
      let text = dec.decode(e.data as ArrayBuffer, { stream: true });
      if (fresh) {
        pending += text;
        const hint = SIZE_HINT.exec(pending);
        // Without a hint (older CLI or a remote host) fall back to 80x24 once output has started.
        if (!hint && pending.length < 64) return;
        term?.dispose();
        el.replaceChildren();
        term = new Terminal({
          cols: hint ? Number(hint[1]) : 80, rows: hint ? Number(hint[2]) : 24, disableStdin: !mayType(lease), cursorBlink: false, fontSize: Number(preferences.font),
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          theme: { ...terminalPalette },
        });
        term.open(el);
        // Clear the new local screen before replay: recycled cells can retain glyphs from a longer line.
        term.write('\x1b[2J\x1b[H');
        // Keys go out as binary frames: the gateway and the host treat a text frame from the page as a violation.
        term.onData((d) => { if (mayType(lease) && sock === ws && sock.readyState === WebSocket.OPEN) sock.send(enc.encode(d)); });
        fresh = false;
        attempt = 0;
        text = pending;
        pending = "";
      }
      text = text.replace(new RegExp(SIZE_HINT.source, "g"), "");
      // ghostty-web 0.4.0 throws "offset is out of bounds" on an empty write.
      if (text) term!.write(text);
    };
    sock.onclose = (e) => {
      if (stopped || sock !== ws) return;
      // A lease belongs to one socket; a reconnect starts read-only.
      show(noLease);
      // 1000: the viewer ended normally (session gone). 1008: the server refused us. Neither is retried.
      if (e.code === 1000 || e.code === 1008) {
        setStatus(terminalClosedText(e.code, e.reason));
        return;
      }
      // 1013: the host is at its viewer cap. Retried slowly, since a slot frees when another viewer closes.
      if (e.code === 1013) {
        attempt = RETRY_MS.length - 1;
        timer = setTimeout(connect, RETRY_MS[attempt]!);
        setStatus(`${terminalClosedText(e.code, e.reason)} · retry in ${Math.round(RETRY_MS[attempt]! / 1000)} s`);
        return;
      }
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
      attempt++;
      setStatus(`Disconnected (${e.code}) · state unknown · retry in ${Math.round(wait / 1000)} s`);
      timer = setTimeout(connect, wait);
    };
  };
  connect();
  return {
    setFontSize(size) { if (term) term.options.fontSize = size; },
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(lapse);
      clearInterval(tick);
      ws?.close();
      term?.dispose();
    },
  };
}

const panes = new Map<string, Pane>();
let renderedPanes = "";

function stopPanes() {
  for (const p of panes.values()) p.stop();
  panes.clear();
}

// Panes belong to the selected host only. They are rebuilt when the host or its set of running
// sessions changes; an unreadable host is stated, never shown as having no sessions.
function renderPanes(h: HostState | undefined) {
  const box = $("terminals");
  const running = h ? h.sessions.filter((s) => s.running) : [];
  const key = !h ? `none:${hostListError}` : running.length ? paneKey(h) : `empty:${h.info.id}#${h.gen}:${h.sessionsRead.status}`;
  if (key !== renderedPanes) {
    renderedPanes = key;
    stopPanes();
    if (!h) {
      const text = enroll && fleet.order.length === 0 && hostListError.startsWith("No hosts yet") ? "No hosts yet" : hostListError ? "No host list" : "Loading hosts";
      box.innerHTML = `<div class="empty"><span>${text}</span></div>`;
    } else if (running.length === 0) {
      const r = h.sessionsRead;
      box.innerHTML = r.status === "loading"
        ? `<div class="empty"><span>Reading sessions on ${esc(h.info.name)}</span></div>`
        : r.status === "unknown"
          ? `<div class="empty"><span>State unknown on ${esc(h.info.name)}</span><small>${esc(r.error ?? "The host could not be read")}. This does not mean it has no sessions or that they stopped.</small></div>`
          : `<div class="empty"><span>No running sessions</span><small>fleet status reports no running session on ${esc(h.info.name)}.</small></div>`;
    } else {
      box.innerHTML = `<header class="stage-heading"></header><div class="stage-grid">` + running.map((s) =>
        `<article class="terminal" data-pane="${esc(s.name)}"><header class="termhead"><strong>${esc(s.name)}</strong><small class="termstate">Connecting</small><button type="button" class="stage-focus" data-host="${esc(h.info.id)}" data-session="${esc(s.name)}" aria-label="Focus ${esc(s.name)}">Focus ↗</button></header><div class="xterm-host"></div><footer class="termfooter"><span class="modelinfo"></span><button type="button" class="typebtn" hidden></button></footer></article>`,
      ).join("") + `</div><div class="stage-meta">ghostty-web · Host terminal output</div><div class="stage-requests"></div>`;
      for (const s of running) panes.set(s.name, openPane(s, box.querySelector(`[data-pane="${CSS.escape(s.name)}"] .xterm-host`) as HTMLElement, h.info));
    }
  }
  // Labels and emphasis change in place, so refreshes never reopen a viewer.
  if (!h) return;
  const unknown = h.sessionsRead.status === "unknown";
  const focused = running.some(s => s.name === focusedPane && s.name === h.selectedSession);
  box.dataset.focused = String(focused);
  const stageHeading = box.querySelector<HTMLElement>('.stage-heading');
  if (stageHeading && running.length) {
    const configuration = mode === 'gateway' && manage ? `<a class="stage-config" href="./workstation?host=${encodeURIComponent(h.info.id)}">Host configuration</a>` : '';
    setHtml(stageHeading, `<small>Ghostty　/　Host sessions</small>${focused ? '<button type="button" data-view="terminals">All terminals</button>' : configuration}`);
  }
  const requestBar = box.querySelector<HTMLElement>('.stage-requests');
  if (requestBar && running.length) {
    const known = h.coordRead.status === 'ready' && !h.info.supervisor;
    const sessions = new Set(focused ? [focusedPane] : running.map(s => s.name));
    const matches = known ? h.coord.requests.filter(q => {
      const origin = q.origin ?? h.coord.runs.find(run => run.id === q.runId)?.orchestrator;
      return typeof origin === 'string' && sessions.has(origin);
    }) : [];
    const links = matches.map(q => {
      const owner = requestOwner(q);
      if (owner === 'malformed') return '<span>Unrecognized request owner</span>';
      const target = owner === 'none' ? 'data-unassigned="yes"' : `data-project="${esc(owner.project)}" data-task="${esc(owner.task)}"`;
      const label = owner === 'none' ? 'Unassigned' : `${esc(owner.project)} / ${esc(owner.task)}`;
      return `<button type="button" data-host="${esc(h.info.id)}" ${target} data-review-request="${esc(q.id)}">${label} / rev ${esc(String(q.revision))}</button>`;
    }).join('');
    setHtml(requestBar, `<strong>Session requests</strong>${links || `<span>${h.info.supervisor ? 'Unavailable in cooperative mode' : known ? 'No matching requests reported' : 'Request state unavailable'}</span>`}`);
  }
  for (const s of running) {
    const art = box.querySelector(`[data-pane="${CSS.escape(s.name)}"]`);
    if (!art) continue;
    art.classList.toggle("active", s.name === h.selectedSession);
    const info = art.querySelector(".modelinfo") as HTMLElement;
    const text = unknown ? "State unknown, host not readable" : modelLabel(s.model);
    if (info.textContent !== text) { info.textContent = text; info.title = unknown ? "The host could not be read" : modelDetail(s.model); }
  }
}

function setInspector(open: boolean, focusToggle = false) {
  inspectorOpen = open;
  $("app").classList.toggle("only-terminal", !open);
  const b = $("inspectorToggle");
  b.setAttribute("aria-expanded", String(open));
  const label = open ? "Hide supervisor panel" : "Show supervisor panel";
  b.setAttribute("aria-label", label);
  b.title = label;
  if (focusToggle) (b as HTMLElement).focus();
}
const overlayQuery = window.matchMedia("(max-width: 900px)");
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && inspectorOpen && overlayQuery.matches) setInspector(false, true);
});

// Supervisor panel: requests, phase record and commands come from the selected host. Every label says
// how far a step got; nothing here claims execution that the supervisor has not reported.
export const commandLabel: Record<string, string> = {
  queued: "Queued, not delivered",
  claimed: "Claimed: reservation only, not acceptance or execution",
  delivering: "Delivering",
  delivered: "Delivered, not acknowledged",
  delivery_unknown: "Delivery unknown",
  accepted: "Accepted, not finished",
  rejected: "Rejected by supervisor",
  running: "Running",
  completed: "Completed (supervisor report)",
  failed: "Failed (supervisor report)",
};
const requestLabel: Record<string, string> = {
  open: "Needs your decision", resolved: "Answered, awaiting acknowledgement", acknowledged: "Acknowledged by supervisor",
  stale: "Stale: the revision moved on", withdrawn: "Withdrawn",
};
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const verb = (r: string) => (r === "approve" ? "Approve" : r === "decline" ? "Decline" : r[0]!.toUpperCase() + r.slice(1));

// The review open in the centre: one project task, or (owner null) the requests of runs registered without one.
let reviewing: { host: string; requestId?: string; owner: { project: string; task: string } | null } | null = null;
// "none": the run was registered without a project. "malformed": half an owner or a value that is not a name.
// The host service stores both or neither, so a malformed owner is not treated as "none" and is in no review.
function requestOwner(q: Pick<Req, 'projectId' | 'taskId'>): { project: string; task: string } | "none" | "malformed" {
  const { projectId: project, taskId: task } = q as { projectId?: unknown; taskId?: unknown };
  if (project == null && task == null) return "none";
  return typeof project === "string" && project && typeof task === "string" && task ? { project, task } : "malformed";
}
function inReview(h: HostState, q: Req): boolean {
  if (reviewing?.host !== h.info.id || (reviewing.requestId !== undefined && reviewing.requestId !== q.id)) return false;
  const want = reviewing.owner, owner = requestOwner(q);
  if (!want) return owner === "none";
  return typeof owner === "object" && owner.project === want.project && owner.task === want.task;
}
let lastReviewNotice: { hostId: string; gen: number; requestId: string; revision: number; text: string } | null = null;
function reportedSession(q?: Req, run?: { orchestrator: string }) {
  return typeof q?.origin === 'string' && q.origin ? q.origin : run?.orchestrator;
}
function renderRequests(h: HostState | undefined) {
  if (reviewing && (!h || h.info.supervisor || h.info.id !== reviewing.host)) reviewing = null;
  const review = $("projectReview") as HTMLDialogElement;
  if (!reviewing && review.open) review.close();
  review.hidden = !reviewing;
  if (reviewing && h) {
    const ready = h.coordRead.status === "ready";
    const owner = reviewing.owner ? `${esc(reviewing.owner.project)} / ${esc(reviewing.owner.task)}` : 'No project assigned';
    // A host can send anything as a revision, so it is escaped like every other host value.
    const rows = (ready ? h.coord.requests.filter((q) => inReview(h, q)) : []).map((q) => {
      const revision = esc(String(q.revision));
      const answers = q.status !== "open" ? "" : q.allowedResponses.map((a) =>
        `<button type="button" data-host="${esc(h.info.id)}" data-request="${esc(q.id)}" data-revision="${revision}" data-answer="${esc(a)}"${h.answering.includes(answerKey(q.id, q.revision)) ? " disabled" : ""}>${a === 'approve' ? `Approve revision ${revision}` : esc(verb(a))}</button>`).join("");
      const orchestrator = typeof q.origin === 'string' ? q.origin : h.coord.runs.find(run => run.id === q.runId)?.orchestrator;
      return `<section class="review-body"><small>${owner} / rev ${revision}</small><h2>${esc(q.question)}</h2><p>${esc(q.id)} · ${esc(h.info.name)}${orchestrator ? ` / ${esc(orchestrator)}` : ''}</p>` +
        `<div class="review-scope"><strong>${q.kind === 'approval' ? 'Approval scope' : 'Request scope'}</strong>${q.proposedAction ? `<p>${esc(q.proposedAction)}</p>` : ''}<p>${esc(q.scope || 'No scope reported.')}</p></div>` +
        (q.evidence.length ? `<details${preferences.evidence === 'expanded' ? ' open' : ''}><summary>Evidence (${q.evidence.length})</summary>${q.evidence.map(e => `<p>${esc(e)}</p>`).join('')}</details>` : '<p class="review-evidence-empty">No evidence supplied.</p>') +
        `<p class="review-status" role="status">${esc(q.phase)} · ${esc(requestLabel[q.status] ?? q.status)}</p>` +
        (lastReviewNotice?.hostId === h.info.id && lastReviewNotice.gen === h.gen && lastReviewNotice.requestId === q.id && lastReviewNotice.revision === q.revision && q.status === 'open' ? `<p role="status">${esc(lastReviewNotice.text)}</p>` : '') +
        (q.response ? `<p>Recorded: ${esc(q.response)}${q.resolvedBy ? ` by ${esc(q.resolvedBy)}` : ''}</p>` : '') +
        (answers ? `<div class="review-actions">${answers}</div>` : '') + `</section>`;
    }).join("");
    setHtml(review, `<header><strong id="reviewTitle">Review request</strong><button type="button" data-close-review="yes" title="Back to ${studioTitles[studioView]}" autofocus>Close ×</button></header>` +
      (rows || `<p>${owner}</p><p>${ready ? "No matching decisions in the current request view." : "Request state unknown."}</p>`));
    if (!review.open) {
      review.oncancel = event => { event.preventDefault(); reviewing = null; render(); };
      review.showModal();
    }
  }
  const box = $("requests");
  if (!h) { setHtml(box, `<div class="sectionheading"><h3>Requests</h3></div><p class="phase-note">No host selected.</p>`); return; }
  if (h.info.supervisor) { setHtml(box, '<div class="sectionheading"><h3>Requests</h3></div><p class="phase-note">Approvals unavailable in cooperative mode.</p>'); return; }
  const r = h.coordRead;
  if (r.status !== "ready") {
    // Last-read requests are not shown as current: they may have been answered or gone stale since.
    const note = r.status === "loading" ? `Reading supervisor state on ${esc(h.info.name)}.` : `${esc(h.info.name)} could not be read${r.at ? ` since ${esc(clock(r.at))}` : ""}. Request state is unknown.`;
    setHtml(box, `<div class="sectionheading"><h3>Requests</h3></div><p class="phase-note">${note}</p>`);
    return;
  }
  const open = h.coord.requests.filter((q) => q.status === "open");
  const shown = open.length ? open : h.coord.requests.slice(-1);
  if (!shown.length) {
    setHtml(box, `<div class="sectionheading"><h3>Requests</h3></div><p class="phase-note">No supervisor request on ${esc(h.info.name)}.</p>`);
    return;
  }
  setHtml(box, shown.map((q: Req) => {
    const owner = requestOwner(q);
    // No answer control here: answers are given in the review in the centre, also for requests with no project.
    const toReview = owner === "malformed" ? `<p>Project and task could not be read. This request cannot be answered.</p>`
      : owner === "none" ? `<p>Project and task not assigned.</p><button type="button" data-host="${esc(h.info.id)}" data-unassigned="yes">Open unassigned decisions</button>`
      : `<button type="button" data-host="${esc(h.info.id)}" data-project="${esc(owner.project)}" data-task="${esc(owner.task)}">Open ${esc(owner.project)} / ${esc(owner.task)}</button>`;
    const result = q.response ? `Answered "${esc(q.response)}" by ${esc(q.resolvedBy ?? "?")}.${q.status === "resolved" ? " The supervisor has not acknowledged it yet." : ""}` : "";
    return `<div class="sectionheading"><h3>Request</h3><span class="requeststatus">${esc(requestLabel[q.status] ?? q.status)}</span></div>` +
      `<h2 class="requesttitle">${esc(q.question)}</h2>` +
      (q.proposedAction ? `<p class="requestcopy">${esc(q.proposedAction)}</p>` : "") +
      `<p class="requestref">${esc(q.id.slice(0, 12))} · ${esc(q.phase)} · revision ${esc(String(q.revision))}</p>` +
      (q.evidence.length || q.scope ? `<details class="requestevidence"><summary>View evidence and scope</summary><dl>${q.evidence.map((e) => `<div><dt>Evidence</dt><dd>${esc(e)}</dd></div>`).join("")}</dl>${q.scope ? `<p class="fineprint">${esc(q.scope)}</p>` : ""}</details>` : "") +
      toReview +
      `<p class="requestresult" aria-live="polite">${result}</p>`;
  }).join(""));
}

function renderWorkflow(h: HostState | undefined) {
  const steps = $("workflowSteps");
  if (h?.info.supervisor) {
    $("coordContext").textContent = h.info.name + " · Cooperative supervisor";
    $("runName").textContent = "";
    $("phaseState").textContent = "Workflow unavailable in cooperative mode.";
    setHtml(steps, "");
    return;
  }
  const known = h?.coordRead.status === "ready";
  const run = known ? currentRun(h!.coord.runs) : undefined;
  const name = h ? h.info.name : "";
  $("coordContext").textContent = !h ? "No host selected"
    : run ? `${name} · ${run.id} · ${run.orchestrator}`
    : known ? `${name} · No run registered`
    : h.coordRead.status === "loading" ? `${name} · Reading` : `${name} · State unknown`;
  $("runName").textContent = run?.id ?? "";
  if (!h || !run) {
    $("phaseState").textContent = !h ? "" : known ? `No run registered on ${name}.` : h.coordRead.status === "loading" ? "Reading workflow state." : "Workflow state unknown.";
    setHtml(steps, "");
    return;
  }
  const reqs = h.coord.requests.filter((r) => r.runId === run.id && r.phase === run.phase && r.revision === run.revision && r.kind === "approval");
  const decision = reqs.find((r) => r.response === "decline") ? "Declined" : reqs.find((r) => r.response === "approve") ? "Approved" : reqs.some((r) => r.status === "open") ? "Pending" : "Not requested";
  $("phaseState").textContent = `${run.phase} · revision ${run.revision} · ${run.phaseStatus}`;
  const rows: [string, string, string, string][] = [
    ["1", run.phase, run.phaseStatus, ""],
    ["·", "Human decision", decision, decision === "Approved" ? "done" : "wait"],
  ];
  setHtml(steps, rows.map(([mark, title, status, kind]) => `<li><span class="stepmark ${kind}">${esc(mark)}</span><span>${esc(title)}</span><small>${esc(status)}</small></li>`).join(""));
}

function renderExchange(h: HostState | undefined) {
  if (h?.info.supervisor) { renderCooperativeExchange(h); return; }
  const cmds: Command[] = h ? h.coord.commands.slice(-SHOWN_COMMANDS) : [];
  setHtml($("exchangeRows"), cmds.map((c) =>
    `<li><div class="exchangemeta"><strong>${esc(c.actor)} → ${esc(c.target)}</strong><time>${esc(time(c.updatedAt))}</time></div><p>${esc(c.text)}</p>` +
    (c.response ? `<p>${esc(c.response)}</p>` : "") +
    `<span class="receipt">${esc(c.id.slice(0, 12))} · ${esc(commandLabel[c.status] ?? c.status)}</span></li>`,
  ).join(""));
  $("eventText").textContent = !h ? ""
    : h.coordRead.status === "unknown" ? `Unreachable${h.coordRead.at ? ` since ${clock(h.coordRead.at)}` : ""}. ${cmds.length ? "These are the last known commands; their status may have changed." : "Command history unknown."}`
    : h.coordRead.status === "loading" ? "Reading commands."
    : cmds.length ? "" : `No commands yet on ${h.info.name}.`;
}

function renderCooperativeExchange(h: HostState) {
  const button = (label: string, action: string, disabled = false, command = "") =>
    '<button type="button" data-fk="' + esc(action + command) + '" data-host="' + esc(h.info.id) + '" data-page="' + action + '" data-command="' + esc(command) + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
  const rows = h.commands.map(c => '<li><div class="exchangemeta"><strong>' + esc(c.actor) + ' → ' + esc(c.target) + '</strong><time>' + esc(time(c.updatedAt)) + '</time></div><p>' + esc(c.text) + '</p><span class="receipt">' + esc(c.id + ' · ' + (commandLabel[c.status] ?? c.status)) + '</span>' + button('Inspect command', 'select', false, c.id) + '</li>').join('');
  let detail = '';
  if (h.selectedCommand) {
    const r = h.inspectionRead;
    detail = '<li><strong>Inspection: ' + esc(h.selectedCommand) + '</strong>';
    if (r.status === 'unknown') detail += '<p>Inspection unknown: ' + esc(r.error ?? 'Read failed') + '. Previous inspection is not current.</p>';
    else if (!h.inspection) detail += '<p>Reading inspection.</p>';
    else {
      const d = h.inspection;
      detail += '<p>Command row: ' + esc(commandLabel[d.command.status] ?? d.command.status) + '</p>';
      detail += d.claim ? '<p>Claim incarnation: ' + esc(d.claim.incarnationId) + ' · incarnationActive: ' + d.claim.incarnationActive + ' · settled: ' + d.claim.settled + '. Settlement is an operator record, not execution.</p>' : '<p>No claim recorded.</p>';
      detail += '<p>Lifecycle reports, separate from command row:</p><ol>' + d.events.map(e => '<li>' + esc(e.seq + ' · ' + e.status + ' · ' + e.detail + ' · ' + e.at) + '</li>').join('') + '</ol>';
      detail += '<p>' + (h.inspectionCursor ? 'More lifecycle events available; shown reports are not complete.' : 'End of events at this read, not a live snapshot.') + '</p>';
      if (h.inspectionCursor) detail += button('Load more events', 'events', !!r.inFlight);
      detail += '<p>Read ' + esc(clock(r.at)) + '</p>';
    }
    detail += button('Refresh inspection', 'inspect', !!r.inFlight) + '</li>';
  }
  setHtml($("exchangeRows"), rows + '<li>' + button('Refresh commands', 'refresh', !!h.commandsRead.inFlight) + (h.commandsCursor ? button('Load more commands', 'commands', !!h.commandsRead.inFlight || h.commandsRead.status !== 'ready') : '') + '</li>' + detail);
  $("eventText").textContent = h.commandsRead.status === 'unknown' ? 'Command history unknown. Last-read rows may have changed. ' + (h.commandsRead.error ?? '')
    : h.commandsRead.status === 'loading' ? 'Reading commands.'
    : h.commandsCursor ? 'Oldest-first page. More commands available; this is not complete history.' : 'End of command history at this read. Pages are live reads, not a snapshot.';
}

const SEND_REASON: Record<string, string> = {
  sending: "Sending", loading: "Reading state", unknown: "State unknown, cannot send", "no-target": "No running session selected", empty: "",
};

function renderComposer(h: HostState | undefined) {
  const box = $("instruction") as HTMLTextAreaElement;
  const send = $("sendInstruction") as HTMLButtonElement;
  const label = $("instructionForm").querySelector("label")!;
  if (!h) {
    label.textContent = "Instruction to supervisor";
    $("composerTarget").textContent = "No host selected";
    $("instructionStatus").textContent = "";
    box.disabled = true;
    send.disabled = true;
    return;
  }
  box.disabled = false;
  label.textContent = `Instruction to supervisor on ${h.info.name}`;
  // The draft belongs to the host; it is swapped in on host switch and only the input handler edits it.
  if (box.value !== h.draft) box.value = h.draft;
  const target = composerTarget(h);
  const gate = sendGate(h, target, box.value);
  $("composerTarget").textContent = gate.ok || gate.reason === "empty"
    ? `To ${target} on ${h.info.name} · ${h.info.supervisor ? "cooperative pull, no wakeup" : "fleet send"}`
    : gate.reason === "no-target" ? `No running session selected on ${h.info.name}`
    : gate.reason === "sending" ? `Sending to ${h.intent?.target ?? target} on ${h.info.name}`
    : `${h.info.name}: ${SEND_REASON[gate.reason]}`;
  $("instructionStatus").textContent = h.notice;
  send.disabled = !gate.ok;
}

let workspaceInspectorOpen = false;
function renderChrome(h: HostState | undefined) {
  const consoleVisible = studioView === 'terminals';
  const contextToggle = $('workspaceInspectorToggle');
  contextToggle.hidden = consoleVisible;
  contextToggle.textContent = workspaceInspectorOpen ? 'Hide inspector' : 'Inspector';
  $('inspectorToggle').hidden = !consoleVisible;
  contextToggle.setAttribute('aria-expanded', String(workspaceInspectorOpen && !consoleVisible));
  $('workspaceInspector').hidden = !workspaceInspectorOpen || consoleVisible;
  $('workspaceInspectorTitle').textContent = studioTitles[studioView];
  $('workspaceInspectorText').textContent = studioView === 'machine' && h ? `${h.info.name} · ${hostSubtitle(h)}` : 'Workspace-level view. Select a host or a request for its details.';
  $('studioCrumb').textContent = reviewing ? 'Workspace　/　Task review' : h && (studioView === 'machine' || studioView === 'terminals') ? `Fleet　/　${h.info.name}` : `Workspace　/　${studioTitles[studioView]}`;
  const title = $("hostTitle");
  title.textContent = h ? h.info.name : "Fleet Control";
  // The header clips long names, so the full name stays reachable as a tooltip.
  title.title = title.textContent;
  const v = h ? describeSessions(h) : null;
  $("hostSubtitle").textContent = !h || !v ? (hostListError || "Loading hosts")
    : v.kind === "loading" ? "Reading sessions"
    : v.kind === "ready" ? `${plural(v.count)} · read ${clock(v.at)}`
    : `State unknown${v.lastKnownCount !== null ? ` · last read ${clock(v.at)}` : ""}`;
  const alert = $("alert");
  const msgs: string[] = [];
  if (hostListError) msgs.push(hostListError);
  if (h?.sessionsRead.status === "unknown") msgs.push(`Cannot read ${h.info.name}: ${h.sessionsRead.error ?? "unreachable"}. Its execution state is unknown, not stopped. Other hosts are unaffected.`);
  else if (!h?.info.supervisor && h?.coordRead.status === "unknown") msgs.push(`Cannot read supervisor state on ${h.info.name}: ${h.coordRead.error ?? "unreachable"}. Request state is unknown.`);
  alert.hidden = msgs.length === 0;
  alert.textContent = msgs.join(" ");
  $("status").textContent = !h ? "Read-only terminals" : (h.info.supervisor ? h.commandsRead.status : h.coordRead.status) === "ready" ? `${h.info.name} · read-only terminals · ${h.info.supervisor ? "cooperative commands, explicit refresh" : "supervisor panel live"}` : `${h.info.name} · state unknown or loading`;
}

// --- managed agents --------------------------------------------------------------------------------
// Per host: the last agent list, whether it is current, the form draft and the last notice.
type AgentView = { list: AgentList | null; status: "loading" | "ready" | "unknown" | "absent"; error: string; busy: boolean; notice: string; form: AgentForm };
const agentViews = new Map<string, AgentView>();
function agentView(hostId: string): AgentView {
  let v = agentViews.get(hostId);
  if (!v) { v = { list: null, status: "loading", error: "", busy: false, notice: "", form: { name: "", kind: fleet.hosts[hostId]?.info.defaultHarness === "deepseek-harness" ? "dsh" : "claude", cwd: "", model: "", prompt: "", confirm: "", orchestrator: false } }; agentViews.set(hostId, v); }
  return v;
}

function renderAgents(h: HostState | undefined) {
  const box = $("agentsBox");
  const form = $("agentForm") as HTMLFormElement;
  // Cooperative hosts are reached through the central supervisor, which has no agent routes.
  if (!h || h.info.supervisor) { box.hidden = true; return; }
  const v = agentView(h.info.id);
  box.hidden = false;
  const list = v.list;
  form.hidden = v.status === "absent";
  const rows = (list?.agents ?? []).map(a => '<li><div class="exchangemeta"><strong>' + esc(a.name) + '</strong><time>' + esc(time(a.updatedAt)) + '</time></div><p>' + esc(agentStateText(a) + ' · ' + KIND_LABEL[a.kind] + ' ' + a.model + (a.orchestrator ? ' · orchestrator' : '') + ' · ' + a.cwd) + '</p>'
    + (canStop(a) ? '<button type="button" class="destructive" data-fk="stop-' + esc(a.name) + '" data-stop="' + esc(a.name) + '" data-host="' + esc(h.info.id) + '"' + (v.busy ? ' disabled' : '') + '>Stop ' + esc(a.name) + '</button>' : '') + '</li>').join('');
  setHtml($("agentRows"), rows);
  $("agentListStatus").textContent = v.status === "absent" ? `Managed agents are not configured on ${h.info.name}.`
    : v.status === "unknown" ? `Agent list unknown: ${v.error}. Agents may still be running.`
    : v.status === "loading" && !list ? "Reading agents."
    : list && list.agents.length === 0 ? `No managed agents on ${h.info.name}.` : "";
  const folder = $("agentFolder") as HTMLSelectElement;
  const model = $("agentModel") as HTMLSelectElement;
  const kind = $("agentKind") as HTMLSelectElement;
  const folders = list?.folders ?? [];
  const kinds = kindsOf(list);
  if (kinds.length && !kinds.includes(v.form.kind)) v.form.kind = kinds[0]!;
  const models = modelsFor(list, v.form.kind);
  if (!v.form.cwd && folders[0]) v.form.cwd = folders[0];
  // A model from the other kind is not kept when the kind changes.
  if (!models.includes(v.form.model)) v.form.model = models[0] ?? "";
  // One kind on offer needs no picker.
  kind.hidden = $("agentKindLabel").hidden = kinds.length < 2;
  setHtml(kind, kinds.map(k => '<option value="' + k + '">' + esc(KIND_LABEL[k]) + '</option>').join(''));
  kind.value = v.form.kind;
  // The option shows only where the host offers it, and only for Claude Code.
  const canOrchestrate = !!list?.orchestrators && v.form.kind === "claude";
  if (!canOrchestrate) v.form.orchestrator = false;
  $("agentOrchestratorRow").hidden = $("agentOrchestratorLabel").hidden = !canOrchestrate;
  ($("agentOrchestrator") as HTMLInputElement).checked = v.form.orchestrator;
  $("agentRisk").textContent = v.form.orchestrator
    ? "The agent runs unattended with permission prompts skipped, inside the chosen folder, with its own token for this host: it can register a run and ask you, never answer for you."
    : v.form.kind === "dsh"
    ? "The agent runs unattended through DSH headless, allowed to write inside the chosen folder."
    : "The agent runs unattended with permission prompts skipped, inside the chosen folder.";
  setHtml(folder, folders.map(f => '<option value="' + esc(f) + '">' + esc(f) + '</option>').join('') || '<option value="">No folders</option>');
  setHtml(model, models.map(m => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join(''));
  folder.value = v.form.cwd;
  model.value = v.form.model;
  for (const [id, key] of [["agentName", "name"], ["agentPrompt", "prompt"], ["agentConfirm", "confirm"]] as const) {
    const el = $(id) as HTMLInputElement;
    if (el.value !== v.form[key]) el.value = v.form[key];
  }
  const gate = startGate(v.form, list, v.busy);
  $("agentGate").textContent = gate.ok ? `Start on ${h.info.name}` : gate.reason;
  ($("agentStart") as HTMLButtonElement).disabled = !gate.ok;
  $("agentStatus").textContent = v.notice;
}

async function refreshAgents(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  if (!host || host.supervisor) return;
  const v = agentView(hostId);
  const { status, outcome } = await hostCall(host, "/agents");
  if (outcome.ok) {
    const list = parseAgents(outcome.data);
    if (list) { v.list = list; v.status = "ready"; v.error = ""; }
    else { v.status = "unknown"; v.error = "malformed answer"; }
  } else if (status === 503 || status === 404) {
    v.list = null; v.status = "absent";
  } else { v.status = "unknown"; v.error = outcome.message; }
  if (selectedHostState(fleet)?.info.id === hostId) renderAgents(selectedHostState(fleet));
}

async function startAgent(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = agentView(hostId);
  if (!host || !startGate(v.form, v.list, v.busy).ok) return;
  const f = { ...v.form };
  v.busy = true;
  v.notice = `Starting ${f.name} on ${host.name}`;
  renderAgents(selectedHostState(fleet));
  const { status, outcome } = await hostCall(host, "/agents", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f),
  }, WRITE_TIMEOUT_MS);
  v.busy = false;
  if (status === 202) {
    v.notice = `${host.name}: ${f.name} accepted, starting. Its terminal appears once the session is open.`;
    v.form = { ...v.form, name: "", prompt: "", confirm: "", orchestrator: false };
  } else if (outcome.ok || status === null || status >= 500) {
    v.notice = `${host.name} did not answer clearly. Unknown whether ${f.name} was started; check the list before starting again.`;
  } else v.notice = `${host.name}: ${f.name} not started: ${outcome.message}`;
  renderAgents(selectedHostState(fleet));
  await refreshAgents(hostId);
  void refresh(hostId, "sessions");
}

async function stopAgent(hostId: string, name: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = agentView(hostId);
  if (!host || v.busy) return;
  v.busy = true;
  v.notice = `Stopping ${name} on ${host.name}`;
  renderAgents(selectedHostState(fleet));
  const { status, outcome } = await hostCall(host, `/agents/${encodeURIComponent(name)}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, WRITE_TIMEOUT_MS);
  v.busy = false;
  const state = outcome.ok ? (outcome.data as { agent?: { state?: string } }).agent?.state : undefined;
  v.notice = outcome.ok ? `${host.name}: ${name} ${state === "stopped" ? "stopped, session closed" : `is ${state ?? "in an unknown state"}`}.`
    : status === null || status >= 500 ? `${host.name} did not answer clearly. Unknown whether ${name} stopped.`
    : `${host.name}: ${name} not stopped: ${outcome.message}`;
  renderAgents(selectedHostState(fleet));
  await refreshAgents(hostId);
  void refresh(hostId, "sessions");
}

// --- fleet administration: fleet.conf, restart one session, logs. Shown only where the host offers it.
const RESTART_TIMEOUT_MS = 190_000;
const adminViews = new Map<string, AdminView>();
function adminView(hostId: string): AdminView {
  let v = adminViews.get(hostId);
  if (!v) { v = emptyAdmin(); adminViews.set(hostId, v); }
  return v;
}

function renderAdmin(h: HostState | undefined) {
  const box = $("adminBox");
  if (!h || h.info.supervisor) { box.hidden = true; return; }
  const v = adminView(h.info.id);
  box.hidden = v.status === "absent" || v.status === "idle";
  $("confPath").textContent = v.conf?.path ?? "";
  const text = $("confText") as HTMLTextAreaElement;
  if (text.value !== v.draft) text.value = v.draft;
  const confirm = $("confConfirm") as HTMLInputElement;
  if (confirm.value !== v.saveConfirm) confirm.value = v.saveConfirm;
  const save = saveGate(v);
  $("confGate").textContent = save.reason;
  ($("confSave") as HTMLButtonElement).disabled = !save.ok;
  ($("confReload") as HTMLButtonElement).disabled = v.busy;
  const sessions = restartable(v.conf, v.sessions);
  if (!sessions.includes(v.restartSession)) v.restartSession = sessions[0] ?? "";
  const label = (s: string) => { const r = v.sessions?.find((x) => x.session === s); return r ? s + (r.inConf ? " · fleet.conf" : r.saved ? " · saved command" : " · no start command") + (r.running ? "" : " · not running") : s; };
  setHtml($("restartSession"), sessions.map(s => '<option value="' + esc(s) + '">' + esc(label(s)) + '</option>').join('') || '<option value="">No sessions</option>');
  ($("restartSession") as HTMLSelectElement).value = v.restartSession;
  const rc = $("restartConfirm") as HTMLInputElement;
  if (rc.value !== v.restartConfirm) rc.value = v.restartConfirm;
  const restart = restartGate(v);
  $("restartGate").textContent = restart.reason;
  ($("restartGo") as HTMLButtonElement).disabled = !restart.ok;
  $("startPart").hidden = v.sessions === null || !v.restartSession || (() => { const r = v.sessions.find((x) => x.session === v.restartSession); return Boolean(r?.inConf && !r.saved); })();
  if (v.sessions) {
    fillStart(v);
    const row = v.sessions.find((r) => r.session === v.restartSession);
    $("startSource").textContent = row?.saved ? `Saved by ${row.saved.savedBy} at ${row.saved.savedAt}.` : row?.pane?.command != null ? "Not saved yet. Filled in from what tmux reports for the running session; check it before saving." : row?.pane ? "Not saved yet. tmux shows this command with characters the page cannot read back; type it in." : "Not saved yet.";
    for (const [id, value] of [["startCommand", v.startCommand], ["startCwd", v.startCwd], ["startConfirm", v.startConfirm]] as const) {
      const el = $(id) as HTMLInputElement;
      if (el.value !== value) el.value = value;
    }
    const sg = startCommandGate(v);
    $("startGate").textContent = sg.reason;
    ($("startSave") as HTMLButtonElement).disabled = !sg.ok;
    ($("startRemove") as HTMLButtonElement).disabled = v.busy || !row?.saved || v.startConfirm !== row.session;
  }
  ($("logSource") as HTMLSelectElement).value = v.logSource;
  ($("logRead") as HTMLButtonElement).disabled = v.busy;
  $("logText").textContent = v.logText;
  const tokens = changeable(v.tokens);
  $("tokenPart").hidden = v.tokens === null;
  setHtml($("tokenRows"), (v.tokens ?? []).map((t) => '<li>' + esc(t.name) + ' <small>' + esc(t.role) + (t.self ? ' · this gateway' : '') + (t.managed ? ' · managed agent' : '') + '</small></li>').join(''));
  if (!tokens.some((t) => t.name === v.tokenName)) { v.tokenName = tokens[0]?.name ?? ""; v.tokenConfirm = ""; }
  setHtml($("tokenName"), tokens.map((t) => '<option value="' + esc(t.name) + '">' + esc(t.name) + '</option>').join('') || '<option value="">No tokens to change</option>');
  ($("tokenName") as HTMLSelectElement).value = v.tokenName;
  ($("tokenAction") as HTMLSelectElement).value = v.tokenAction;
  const tc = $("tokenConfirm") as HTMLInputElement;
  if (tc.value !== v.tokenConfirm) tc.value = v.tokenConfirm;
  const tg = tokenGate(v);
  $("tokenGate").textContent = tg.reason;
  ($("tokenGo") as HTMLButtonElement).disabled = !tg.ok;
  $("tokenGo").textContent = v.tokenAction === "rotate" ? "Rotate token" : "Revoke token";
  $("newTokenBox").hidden = !v.newToken;
  $("newTokenName").textContent = v.tokenName;
  $("newTokenText").textContent = v.newToken;
  $("hostPart").hidden = !manage || mode !== "gateway";
  ($("workstationEditor") as HTMLAnchorElement).href = `./workstation?host=${encodeURIComponent(h.info.id)}`;
  const hc = $("hostConfirm") as HTMLInputElement;
  if (hc.value !== v.hostConfirm) hc.value = v.hostConfirm;
  ($("hostRevoke") as HTMLInputElement).checked = v.hostRevoke;
  const hg = hostGate(v, h.info.id);
  $("hostGate").textContent = hg.reason;
  ($("hostRotate") as HTMLButtonElement).disabled = !hg.ok;
  ($("hostRemove") as HTMLButtonElement).disabled = !hg.ok;
  $("settingsPart").hidden = v.settings === null && v.settingsError === "";
  $("settingsError").textContent = v.settingsError ? `The settings file cannot be used: ${v.settingsError}` : v.settings?.skipped ? `At its last start the service skipped the settings file: ${v.settings.skipped}. The file has not changed since; fix it on the host, or save from here to replace it.` : "";
  $("settingsError").hidden = $("settingsError").textContent === "";
  $("settingsForm").hidden = v.settings === null;
  if (v.settings) {
    $("settingsPath").textContent = `Kept in ${v.settings.path}. The service reads it when it starts; the running service keeps what it started with. The file keeps only what differs from the service's plist or unit.`;
    for (const [id, value] of [["setRoots", v.settingsDraft.agentRoots], ["setModels", v.settingsDraft.agentModels], ["setDsh", v.settingsDraft.agentDshModels], ["setMcp", v.settingsDraft.agentMcpUrl], ["settingsConfirm", v.settingsConfirm]] as const) {
      const el = $(id) as HTMLInputElement;
      if (el.value !== value) el.value = value;
    }
    ($("setInput") as HTMLInputElement).checked = v.settingsDraft.input;
    // Which settings the file sets, and what the plist or unit has for them.
    const set = v.settings.saved;
    $("settingsSource").textContent = set.length ? `Set here (over the plist or unit): ${set.join(", ")}. Put a value back to the plist's to drop it from the file.` : "Nothing set here; every value comes from the plist or unit.";
    // A file the start skipped would be skipped again, so do not promise a restart applies it.
    $("settingsPending").textContent = v.settings.skipped ? "The running service uses the plist's or unit's values." : v.settings.restartNeeded.length ? `Waiting for a restart of the service: ${v.settings.restartNeeded.join(", ")}.` : "The running service uses these settings.";
    const sg = settingsGate(v);
    $("settingsGate").textContent = sg.reason;
    ($("settingsSave") as HTMLButtonElement).disabled = !sg.ok;
  }
  $("servicePart").hidden = v.service === null;
  if (v.service) {
    const s = v.service;
    const cur = s.current.commit ? `${s.current.tag ?? "built by hand"} (${s.current.commit.slice(0, 7)})` : "unknown (no MANIFEST.json)";
    $("serviceCurrent").textContent = `Runs ${cur}.${s.releaseError ? ` Releases could not be read: ${s.releaseError}.` : ""}`;
    ($("serviceAction") as HTMLSelectElement).value = v.serviceAction;
    const tags = s.releases.map((r) => `<option value="${esc(r.tag)}">${esc(r.tag)} · ${esc(r.commit.slice(0, 7))}${r.commit === s.current.commit ? " · running" : ""}</option>`).join("");
    const sel = $("serviceTag") as HTMLSelectElement;
    if (sel.dataset.tags !== tags) { sel.innerHTML = `<option value="">Choose a release</option>${tags}`; sel.dataset.tags = tags; }
    sel.value = v.serviceTag;
    sel.hidden = $("serviceTagLabel").hidden = v.serviceAction !== "update";
    $("serviceConfirmLabel").textContent = `Type ${serviceWord(v) || "the release tag"} to confirm`;
    const c = $("serviceConfirm") as HTMLInputElement;
    if (c.value !== v.serviceConfirm) c.value = v.serviceConfirm;
    const g = serviceGate(v);
    $("serviceGate").textContent = g.reason;
    const go = $("serviceGo") as HTMLButtonElement;
    go.disabled = !g.ok;
    go.textContent = v.serviceAction === "restart" ? "Restart" : "Update";
    const j = s.running ?? s.jobs[0];
    $("serviceSteps").innerHTML = j ? `<li><strong>${esc(j.action === "update" ? `Update to ${j.tag}` : j.action === "move" ? "Move fleet" : "Restart")} · ${esc(j.state)}</strong> · ${esc(j.by)} · ${esc(j.startedAt)}</li>${j.steps.map((x) => `<li>${esc(x)}</li>`).join("")}` : "";
  }
  $("movePart").hidden = v.move === null;
  if (v.move) {
    const m = v.move;
    $("moveFrom").textContent = `Now: fleet ${m.from.fleet} in ${m.from.dir}, tmux socket ${m.from.socket || "(tmux default)"}.${m.blockers.length ? ` Blocked: ${m.blockers.join("; ")}.` : ""}`;
    for (const [id, val] of [["moveFleet", v.moveFleet], ["moveDir", v.moveDir], ["moveSocket", v.moveSocket], ["moveConfirm", v.moveConfirm]] as const) {
      const e = $(id) as HTMLInputElement;
      if (e.value !== val) e.value = val;
    }
    const mg = moveGate(v);
    $("moveGate").textContent = mg.reason;
    ($("moveGo") as HTMLButtonElement).disabled = !mg.ok;
  }
  $("watchdogPart").hidden = v.watchdog === null;
  if (v.watchdog) {
    const w = v.watchdog;
    $("watchdogState").textContent = (!w.manager ? "This host has neither launchd nor systemd." : w.running && w.inTmux ? `On: ${w.name} runs (pid ${w.pid}), and a second watchdog runs by hand in tmux session ${w.fleet}-watchdog. Stop that one with fleet watchdog stop.` : w.running ? `On: ${w.name} runs (pid ${w.pid}). It checks every agent every 60 s and starts again at login.` : w.inTmux ? `Off as a service. A watchdog started by hand runs in tmux session ${w.fleet}-watchdog.` : w.inTmux === null ? "Off as a service." : `Off: no watchdog checks the agents of ${w.fleet}.`) + (w.inTmux === null ? ` Cannot tell whether a watchdog runs in tmux: ${w.inTmuxError ?? "tmux did not answer"}.` : "");
    const wc = $("watchdogConfirm") as HTMLInputElement;
    if (wc.value !== v.watchdogConfirm) wc.value = v.watchdogConfirm;
    const wg = watchdogGate(v);
    $("watchdogGate").textContent = wg.reason;
    const go = $("watchdogGo") as HTMLButtonElement;
    go.textContent = wg.on ? "Turn on" : "Turn off";
    go.classList.toggle("danger", !wg.on);
    go.disabled = !wg.ok;
  }
  renderInfra(v);
  renderFiles(v);
  $("adminStatus").textContent = v.status === "unknown" ? `Fleet settings unknown: ${v.error}` : v.conf?.loadError ? `fleet.conf does not load: ${v.conf.loadError}` : v.notice;
}

// The file editor part: a folder lists its entries as buttons; a file shows its text with a confirm step.
function renderFiles(v: AdminView) {
  $("filesPart").hidden = v.fileRoots === null;
  if (v.fileRoots === null) return;
  $("fileRootsText").textContent = v.fileRoots.length ? `Opens text files in ${v.fileRoots.join(", ")}.` : "No folders are allowed on this host.";
  const p = $("filePath") as HTMLInputElement;
  if (p.value !== v.filePath) p.value = v.filePath;
  const open = v.fileOpen;
  const list = $("fileList");
  list.hidden = open?.kind !== "dir" && !(open === null && v.fileRoots.length > 0 && !v.fileNew);
  if (open?.kind === "dir") {
    list.innerHTML = open.entries.map((e) => `<li><button type="button" class="fileentry" data-file="${esc(e.name)}" data-kind="${e.kind}">${esc(e.name)}${e.kind === "dir" ? "/" : ""}</button><span class="fineprint">${e.kind === "file" ? `${Math.ceil(e.size / 1024)} KiB` : e.kind === "other" ? "link or special" : ""}</span></li>`).join("") + (open.truncated ? `<li class="fineprint">Only the first entries are shown.</li>` : "") + (open.entries.length === 0 ? `<li class="fineprint">Empty folder.</li>` : "");
  } else if (open === null && !v.fileNew) {
    list.innerHTML = v.fileRoots.map((r) => `<li><button type="button" class="fileentry" data-root="${esc(r)}" data-kind="dir">${esc(r)}/</button></li>`).join("");
  }
  const editing = v.fileNew || open?.kind === "file";
  const t = $("fileText") as HTMLTextAreaElement;
  t.hidden = !editing;
  $("fileSaveRow").hidden = !editing;
  if (editing && t.value !== v.fileDraft) t.value = v.fileDraft;
  ($("fileUp") as HTMLButtonElement).disabled = !open || open.path === open.root || v.busy;
  ($("fileOpenBtn") as HTMLButtonElement).disabled = v.busy;
  for (const b of list.querySelectorAll?.("button.fileentry") ?? []) (b as HTMLButtonElement).disabled = v.busy;
  if (editing) {
    const name = fileName(v.fileNew ? v.filePath : open!.path);
    $("fileConfirmLabel").textContent = `Type ${name} to confirm`;
    const c = $("fileConfirm") as HTMLInputElement;
    if (c.value !== v.fileConfirm) c.value = v.fileConfirm;
    const g = fileGate(v);
    $("fileGate").textContent = g.reason;
    ($("fileSave") as HTMLButtonElement).disabled = !g.ok;
  }
}

async function openFile(hostId: string, path: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  if (!host || v.busy) return;
  // After a refused save the page already said to copy the edit and open the file again; that open goes straight through.
  if (fileDirty(v) && !v.fileChangedOnHost && v.fileLeaving !== path) {
    v.fileLeaving = path;
    v.notice = `${host.name}: the open file has unsaved changes. Ask for ${path} again to drop them.`;
    renderAdmin(selectedHostState(fleet));
    return;
  }
  v.fileLeaving = "";
  v.busy = true;
  renderAdmin(selectedHostState(fleet));
  const { outcome } = await hostCall(host, `/files?path=${encodeURIComponent(path)}`);
  v.busy = false;
  if (outcome.ok) {
    const read = parseFileOpen(outcome.data);
    if (read) {
      v.fileOpen = read; v.filePath = read.path; v.fileNew = false; v.fileChangedOnHost = false; v.fileConfirm = "";
      v.fileDraft = read.kind === "file" ? read.text : "";
      v.notice = "";
    } else v.notice = `${host.name}: the host's answer for ${path} was not understood.`;
  } else v.notice = `${host.name}: ${outcome.message}`;
  renderAdmin(selectedHostState(fleet));
}

async function saveFile(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  if (!host || !fileGate(v).ok) return;
  const path = v.fileNew ? v.filePath : v.fileOpen!.path;
  const revision = v.fileNew ? "new" : (v.fileOpen as { revision: string }).revision;
  v.busy = true;
  renderAdmin(selectedHostState(fleet));
  const { status, outcome } = await hostCall(host, "/files", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, text: v.fileDraft, revision, confirm: v.fileConfirm }) }, WRITE_TIMEOUT_MS);
  v.busy = false;
  if (outcome.ok) {
    const r = outcome.data as { path?: string; revision?: string; backup?: string | null };
    v.notice = `${host.name}: saved ${r.path ?? path}${r.backup ? `; the old text is in ${r.backup}` : ""}.`;
    if (typeof r.revision === "string") { v.fileOpen = { kind: "file", path: r.path ?? path, root: v.fileOpen?.root ?? "", text: v.fileDraft, revision: r.revision, size: new TextEncoder().encode(v.fileDraft).length }; v.fileNew = false; v.filePath = r.path ?? path; }
    v.fileConfirm = "";
  } else {
    if (status === 409) v.fileChangedOnHost = true;
    v.notice = `${host.name}: ${outcome.message}`;
  }
  renderAdmin(selectedHostState(fleet));
}

function renderInfra(v: AdminView) {
  $("infraPart").hidden = v.infra === null;
  const i = v.infra;
  if (!i) return;
  const certLine = (c: (typeof i.certs)[number]) => c.error
    ? `${c.id === "lan" ? "LAN" : "Tailnet"} certificate ${c.path}: cannot read it (${c.error})`
    : `${c.id === "lan" ? "LAN" : "Tailnet"} certificate for ${c.names.join(", ")}: valid to ${c.notAfter.slice(0, 10)}, ${c.daysLeft} days left${c.daysLeft < 30 ? " (renew soon)" : ""}${c.renewable ? "" : c.id === "tailnet" ? "; renew it on the host" : "; made by hand"}`;
  const certLines = [...i.certs.map(certLine), ...(i.renewedAt ? [`Renewed ${i.renewedAt.slice(0, 16).replace("T", " ")} UTC; the service takes it at its next start.`] : [])];
  $("infraCerts").innerHTML = certLines.map((l) => `<li>${esc(l)}</li>`).join("");
  $("infraServices").innerHTML = i.services.map((s) => `<li>${esc(`${s.name} (${s.target}): ${s.running === null ? "unknown" : s.running ? "running" : "stopped"}, ${s.detail}`)}</li>`).join("");
  $("infraServe").textContent = "text" in i.serve ? (i.serve.text || "Nothing served.") : `Cannot read it: ${i.serve.error}`;
  const sel = $("infraAction") as HTMLSelectElement;
  const options: [string, string][] = [["", "Choose"], ...(i.certs.some((c) => c.id === "tailnet" && c.renewable) ? [["renew", "Renew the tailnet certificate"] as [string, string]] : []), ...i.services.map((s): [string, string] => [s.name, `Restart ${s.name}`])];
  const html = options.map(([val, label]) => `<option value="${esc(val)}">${esc(label)}</option>`).join("");
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  if (!options.some(([val]) => val === v.infraService)) v.infraService = "";
  sel.value = v.infraService;
  const ic = $("infraConfirm") as HTMLInputElement;
  if (ic.value !== v.infraConfirm) ic.value = v.infraConfirm;
  const g = infraGate(v);
  $("infraConfirmLabel").textContent = v.infraService === "renew" ? "Type renew to confirm" : v.infraService ? `Type ${v.infraService} to confirm` : "Type to confirm";
  $("infraGate").textContent = g.reason;
  const go = $("infraGo") as HTMLButtonElement;
  go.textContent = g.action === "renew" ? "Renew" : g.action === "restart" ? "Restart" : "Do it";
  go.disabled = !g.ok;
}

async function runInfra(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  const g = infraGate(v);
  if (!host || !g.ok) return;
  const what = v.infraService;
  v.busy = true; v.notice = g.action === "renew" ? `Renewing the tailnet certificate on ${host.name}` : `Restarting ${what} on ${host.name}`;
  renderAdmin(selectedHostState(fleet));
  const path = g.action === "renew" ? "/infra/renew" : `/infra/services/${encodeURIComponent(what)}/restart`;
  const { status, outcome } = await hostCall(host, path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: v.infraConfirm }),
  }, INFRA_TIMEOUT_MS);
  v.busy = false; v.infraConfirm = ""; v.infraService = "";
  if (outcome.ok) {
    const r = outcome.data as { renewed?: unknown; cert?: { notAfter?: unknown } };
    const until = typeof r.cert?.notAfter === "string" ? r.cert.notAfter.slice(0, 10) : "?";
    v.notice = g.action !== "renew" ? `${host.name}: ${what} restarted.`
      : r.renewed === true ? `${host.name}: tailnet certificate renewed (valid to ${until}). The service takes it at its next start.`
      : `${host.name}: tailscale returned the current certificate (valid to ${until}); nothing changed.`;
  }
  else v.notice = status === null || status >= 500 ? `${host.name} did not answer clearly. Unknown whether ${g.action === "renew" ? "the certificate was renewed" : `${what} restarted`}; read the host again.` : `${host.name}: ${g.action === "renew" ? "certificate not renewed" : `${what} not restarted`}: ${outcome.message}`;
  await refreshAdmin(hostId);
}

// keep: which unsaved drafts survive this read. Reload of one part, or a save of it, drops only that part's draft.
async function refreshAdmin(hostId: string, keep: { conf?: boolean; settings?: boolean } = {}) {
  const keepDraft = keep.conf ?? true;
  const host = fleet.hosts[hostId]?.info;
  if (!host || host.supervisor) return;
  const v = adminView(hostId);
  const { status, outcome } = await hostCall(host, "/fleet/conf");
  if (outcome.ok) {
    const conf = parseConf(outcome.data);
    if (conf) {
      // An unsaved edit keeps the file it was made from, so its save still names that revision and the host
      // refuses it if the file moved on. Only Reload or a clean draft takes the new file.
      const dirty = keepDraft && v.conf !== null && v.draft !== v.conf.text;
      if (dirty) v.changedOnHost = conf.revision !== v.conf!.revision;
      else { v.conf = conf; v.draft = conf.text; v.changedOnHost = false; }
      v.status = "ready"; v.error = "";
    } else { v.status = "unknown"; v.error = "malformed answer"; }
  // The section hides, but an unsaved edit and the file it was made from stay for when it comes back.
  } else if (status === 404 || status === 503) { v.status = "absent"; }
  // An agent or viewer token sees nothing here; the host refuses it.
  else if (status === 403) { v.status = "absent"; }
  else { v.status = "unknown"; v.error = outcome.message; }
  // Sessions with saved start commands: hosts without them keep the fleet.conf list.
  if (v.status === "ready") {
    const listed = await hostCall(host, "/fleet/sessions");
    v.sessions = listed.outcome.ok ? parseRestartable(listed.outcome.data) : null;
  }
  // Tokens: hidden where the host does not offer them (older releases, no fleet administration).
  if (v.status === "ready") {
    const t = await hostCall(host, "/tokens");
    v.tokens = t.outcome.ok ? parseTokens(t.outcome.data) : null;
    // Settings: hidden where the host does not offer them. An unsaved edit stays through a refresh.
    const st = await hostCall(host, "/settings");
    const read = st.outcome.ok ? parseSettings(st.outcome.data) : null;
    const dirty = (keep.settings ?? true) && v.settings !== null && JSON.stringify(settingsBody(v.settingsDraft)) !== JSON.stringify(settingsBody(draftOf(v.settings.next)));
    v.settingsError = !st.outcome.ok && st.status === 400 ? st.outcome.message : "";
    if (read) {
      // Like fleet.conf: an unsaved edit keeps the revision it was made from; only Reload or a clean draft moves on.
      if (dirty) { v.settingsChangedOnHost = read.revision !== v.settings!.revision; if (!v.settingsChangedOnHost) v.settings = read; }
      else { v.settings = read; v.settingsDraft = draftOf(read.next); v.settingsChangedOnHost = false; }
    } else if (!dirty) { v.settings = null; v.settingsChangedOnHost = false; }
    // Service restart and update: hidden where the host does not offer them. Started now and read last, so a
    // cold release list does not hold back the parts below.
    const serviceRead = hostCall(host, "/service", {}, SERVICE_READ_TIMEOUT_MS);
    // Watchdog: hidden where the host does not offer it.
    const wd = await hostCall(host, "/watchdog");
    v.watchdog = wd.outcome.ok ? parseWatchdog(wd.outcome.data) : null;
    // Certificates, Serve and other services: hidden where the host does not offer them.
    const inf = await hostCall(host, "/infra");
    v.infra = inf.outcome.ok ? parseInfra(inf.outcome.data) : null;
    // File editor: hidden where the host does not offer it. The open folder or file is not reread here.
    // Move fleet: hidden where the host does not offer it.
    const mv = await hostCall(host, "/fleet/move");
    v.move = mv.outcome.ok ? parseMove(mv.outcome.data) : null;
    const fr = await hostCall(host, "/files");
    v.fileRoots = fr.outcome.ok ? parseFileRoots(fr.outcome.data) : null;
    if (selectedHostState(fleet)?.info.id === hostId) renderAdmin(selectedHostState(fleet));
    const sv = await serviceRead;
    v.service = sv.outcome.ok ? parseService(sv.outcome.data) : null;
  }
  if (selectedHostState(fleet)?.info.id === hostId) renderAdmin(selectedHostState(fleet));
}

async function changeToken(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  if (!host || !tokenGate(v).ok) return;
  const name = v.tokenName, action = v.tokenAction;
  v.busy = true; v.newToken = ""; v.notice = `${action === "rotate" ? "Rotating" : "Revoking"} ${name} on ${host.name}`;
  renderAdmin(selectedHostState(fleet));
  const { status, outcome, kind } = await hostCall(host, `/tokens/${encodeURIComponent(name)}/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: v.tokenConfirm }),
  }, WRITE_TIMEOUT_MS);
  v.busy = false; v.tokenConfirm = "";
  const token = outcome.ok ? (outcome.data as { token?: unknown }).token : undefined;
  if (outcome.ok && action === "rotate" && typeof token === "string") {
    v.newToken = token;
    v.notice = `${host.name}: ${name} rotated. Give the new token to whoever uses ${name}.`;
  } else v.notice = outcome.ok ? `${host.name}: ${name} ${action === "rotate" ? "rotated, but no token came back" : "revoked"}.`
    // The gateway turns the host's 401/403 into 502 with a kind; those are definite refusals, not unknowns.
    : kind === "upstream_forbidden" || kind === "upstream_unauthorized" ? `${host.name}: ${name} not changed: the host refused this gateway (${outcome.message}).`
    : status === null || status >= 500 ? `${host.name} did not answer clearly. Unknown whether ${name} was ${action === "rotate" ? "rotated" : "revoked"}.`
    : `${host.name}: ${name} not changed: ${outcome.message}`;
  renderAdmin(selectedHostState(fleet));
  await refreshAdmin(hostId);
}

// Restart or update the host service. The host answers 202 once the updater has its job; the page then polls
// until the job ends, through the service going away and coming back.
async function runService(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  if (!host || !serviceGate(v).ok) return;
  const action = v.serviceAction;
  const body = action === "restart" ? { confirm: v.serviceConfirm } : { tag: v.serviceTag, confirm: v.serviceConfirm };
  v.busy = true; v.notice = action === "restart" ? `Restarting ${host.name}` : `Updating ${host.name} to ${v.serviceTag}`;
  renderAdmin(selectedHostState(fleet));
  const { status, outcome } = await hostCall(host, `/service/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, SERVICE_TIMEOUT_MS);
  v.busy = false; v.serviceConfirm = "";
  const id = outcome.ok ? ((outcome.data as { job?: { id?: unknown } }).job?.id) : undefined;
  if (typeof id !== "string") {
    v.notice = status === null || status >= 500 ? `${host.name} did not answer clearly. Unknown whether the ${action} started.` : `${host.name}: ${action} not started: ${outcome.ok ? "malformed answer" : outcome.message}`;
    renderAdmin(selectedHostState(fleet));
    return;
  }
  v.notice = `${host.name}: ${action} started (${id}).`;
  renderAdmin(selectedHostState(fleet));
  await followJob(hostId, host, id, action);
}

// Poll an updater job until it ends, through the service going away and coming back.
async function followJob(hostId: string, host: HostInfo, id: string, action: string) {
  const v = adminView(hostId);
  // Bounded by time as well as count: a host that accepts and then hangs makes each poll wait its full timeout.
  const deadline = Date.now() + SERVICE_POLLS * SERVICE_POLL_MS;
  for (let i = 0; i < SERVICE_POLLS && Date.now() < deadline; i++) {
    await new Promise((r) => setTimeout(r, SERVICE_POLL_MS));
    const sv = await hostCall(host, "/service", {}, SERVICE_READ_TIMEOUT_MS);
    const read = sv.outcome.ok ? parseService(sv.outcome.data) : null;
    if (!read) { v.notice = `${host.name}: ${action} ${id} running; the service is not answering yet.`; renderAdmin(selectedHostState(fleet)); continue; }
    v.service = read;
    const j = read.jobs.find((x) => x.id === id);
    if (j && j.endedAt) {
      v.notice = `${host.name}: ${action} ${j.state === "done" ? "done" : j.state === "rolled_back" ? "failed and was rolled back" : "failed"}. ${j.steps.at(-1) ?? ""}`;
      renderAdmin(selectedHostState(fleet));
      await refreshAdmin(hostId);
      return;
    }
    renderAdmin(selectedHostState(fleet));
  }
  v.notice = `${host.name}: ${action} ${id} has not ended after ${Math.round(SERVICE_POLLS * SERVICE_POLL_MS / 60000)} min; its steps show where it is.`;
  renderAdmin(selectedHostState(fleet));
}

// Move the fleet: the host checks again and gives the updater a move job; the page follows it like an update.
async function runMove(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  if (!host || !moveGate(v).ok) return;
  const body = { fleet: v.moveFleet.trim(), dir: v.moveDir.trim(), socket: v.moveSocket.trim(), confirm: v.moveConfirm };
  v.busy = true; v.notice = `Moving the fleet on ${host.name} to ${body.dir}`;
  renderAdmin(selectedHostState(fleet));
  const { status, outcome } = await hostCall(host, "/fleet/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, SERVICE_TIMEOUT_MS);
  v.busy = false; v.moveConfirm = "";
  const id = outcome.ok ? ((outcome.data as { job?: { id?: unknown } }).job?.id) : undefined;
  if (typeof id !== "string") {
    v.notice = status === null || status >= 500 ? `${host.name} did not answer clearly. Unknown whether the move started.` : `${host.name}: not moved: ${outcome.ok ? "malformed answer" : outcome.message}`;
    renderAdmin(selectedHostState(fleet));
    return;
  }
  v.notice = `${host.name}: move started (${id}).`;
  renderAdmin(selectedHostState(fleet));
  await followJob(hostId, host, id, "move");
}

async function setWatchdog(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  const g = watchdogGate(v);
  if (!host || !g.ok) return;
  v.busy = true; v.notice = `${g.on ? "Starting" : "Stopping"} the watchdog on ${host.name}`;
  renderAdmin(selectedHostState(fleet));
  const { status, outcome } = await hostCall(host, "/watchdog", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: g.on, confirm: v.watchdogConfirm }),
  }, WATCHDOG_TIMEOUT_MS);
  v.busy = false; v.watchdogConfirm = "";
  const read = outcome.ok ? parseWatchdog(outcome.data) : null;
  if (read) { v.watchdog = read; v.notice = `${host.name}: watchdog ${read.running ? "on" : "off"}.`; }
  else v.notice = status === null || status >= 500 ? `${host.name} did not answer clearly. Unknown whether the watchdog is ${g.on ? "on" : "off"}; read it again.` : `${host.name}: watchdog not ${g.on ? "started" : "stopped"}: ${outcome.ok ? "malformed answer" : outcome.message}`;
  renderAdmin(selectedHostState(fleet));
  if (!read) await refreshAdmin(hostId);
}

async function saveSettings(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  if (!host || !v.settings || !settingsGate(v).ok) return;
  v.busy = true; v.notice = `Saving settings on ${host.name}`;
  renderAdmin(selectedHostState(fleet));
  const { status, outcome } = await hostCall(host, "/settings", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: settingsBody(v.settingsDraft), revision: v.settings.revision, confirm: v.settingsConfirm }),
  }, WRITE_TIMEOUT_MS);
  v.busy = false; v.settingsConfirm = "";
  const read = outcome.ok ? parseSettings(outcome.data) : null;
  if (read) {
    v.settings = read; v.settingsDraft = draftOf(read.next);
    v.notice = `${host.name}: settings saved. ${read.restartNeeded.length ? "They apply when the service restarts." : "Nothing to restart for."}`;
  } else {
    if (status === 409) v.settingsChangedOnHost = true;
    v.notice = status === null || status >= 500 ? `${host.name} did not answer clearly. Unknown whether the settings were saved.` : `${host.name}: settings not saved: ${outcome.ok ? "malformed answer" : outcome.message}`;
  }
  renderAdmin(selectedHostState(fleet));
}

// This gateway's link to a host. Not a host route: the gateway itself does it, at /api/manage.
async function manageHost(hostId: string, action: "rotate" | "remove") {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  if (!host || !hostGate(v, hostId).ok) return;
  v.busy = true; v.notice = action === "rotate" ? `Rotating this gateway's token for ${host.name}` : `Removing ${host.name}`;
  renderAdmin(selectedHostState(fleet));
  let status: number | null = null, body: unknown = null;
  try {
    const res = await fetch(`./api/manage/${encodeURIComponent(hostId)}/${action}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "rotate" ? { confirm: v.hostConfirm } : { confirm: v.hostConfirm, revoke: v.hostRevoke }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    status = res.status; body = await res.json().catch(() => null);
  } catch { status = null; }
  v.busy = false; v.hostConfirm = "";
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  const why = typeof message === "string" ? message : `the gateway answered ${status}`;
  if (status === 200 && action === "remove") {
    const r = body as { revokedOnHost?: boolean };
    adminViews.delete(hostId);
    await loadHostList();
    $("status").textContent = r.revokedOnHost ? `${host.name} removed; its line for this gateway is revoked.` : `${host.name} removed. Its line for this gateway stays on the host; revoke it there.`;
    return;
  }
  v.notice = status === 200 ? `${host.name}: this gateway now uses a new token; the old one stopped working.`
    : status === null ? `The gateway did not answer. Unknown whether ${host.name} was ${action === "rotate" ? "given a new token" : "removed"}; reload the page.`
    : `${host.name}: ${why}`;
  renderAdmin(selectedHostState(fleet));
}

async function saveConf(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  if (!host || !v.conf || !saveGate(v).ok) return;
  v.busy = true; v.notice = `Saving fleet.conf on ${host.name}`;
  renderAdmin(selectedHostState(fleet));
  const { status, outcome } = await hostCall(host, "/fleet/conf", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: v.draft, revision: v.conf.revision, confirm: v.saveConfirm }),
  }, WRITE_TIMEOUT_MS);
  v.busy = false;
  if (outcome.ok) {
    const backup = (outcome.data as { backup?: string | null }).backup;
    v.notice = `${host.name}: fleet.conf saved${backup ? `; the previous file is ${backup}` : ""}. Running sessions keep going; restart one to apply its change.`;
    v.saveConfirm = "";
    await refreshAdmin(hostId, { conf: false });
    return;
  }
  if (status === 409) v.changedOnHost = true;
  v.notice = status === 409 ? `${host.name}: ${outcome.message}. Your edit is still here; copy it before reloading.`
    : status === null || status >= 500 ? `${host.name} did not answer clearly. Unknown whether fleet.conf was saved; reload before saving again.`
    : `${host.name}: fleet.conf not saved: ${outcome.message}`;
  renderAdmin(selectedHostState(fleet));
}

async function restartSession(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  if (!host || !restartGate(v).ok) return;
  const s = v.restartSession;
  v.busy = true; v.notice = `Restarting ${s} on ${host.name}; a start can take up to 90 s`;
  renderAdmin(selectedHostState(fleet));
  const { status, outcome } = await hostCall(host, `/sessions/${encodeURIComponent(s)}/restart`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: v.restartConfirm }),
  }, RESTART_TIMEOUT_MS);
  v.busy = false;
  v.restartConfirm = "";
  // The gateway gives up first (504) or loses the host (502): the restart may still be going on.
  v.notice = outcome.ok ? `${host.name}: ${s} started again.`
    : status === null || status === 502 || status === 504 ? `${host.name} did not answer in time. Unknown whether ${s} is running; check its terminal.`
    // 422: the old session ended and the start failed; that is known, so it is said as it is.
    : status === 422 ? `${host.name}: ${outcome.message}`
    : `${host.name}: ${s} not restarted: ${outcome.message}`;
  renderAdmin(selectedHostState(fleet));
  void refresh(hostId, "sessions");
}

async function changeStart(hostId: string, remove: boolean) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  const s = v.restartSession;
  if (!host || !s || (!remove && !startCommandGate(v).ok) || (remove && v.startConfirm !== s)) return;
  v.busy = true;
  renderAdmin(selectedHostState(fleet));
  const path = `/sessions/${encodeURIComponent(s)}/start`;
  const { outcome } = remove
    ? await hostCall(host, `${path}?confirm=${encodeURIComponent(v.startConfirm)}`, { method: "DELETE" })
    : await hostCall(host, path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: v.startCommand, cwd: v.startCwd, confirm: v.startConfirm }) });
  v.busy = false;
  v.notice = outcome.ok ? `${host.name}: ${remove ? `saved start command for ${s} forgotten` : `start command for ${s} saved`}.` : `${host.name}: ${s} not changed: ${outcome.message}`;
  // Re-read so the form shows what the host now has.
  if (outcome.ok) v.startFor = "";
  await refreshAdmin(hostId);
}

async function readLog(hostId: string) {
  const host = fleet.hosts[hostId]?.info;
  const v = adminView(hostId);
  if (!host || v.busy) return;
  v.busy = true; v.notice = `Reading the ${v.logSource} log on ${host.name}`;
  renderAdmin(selectedHostState(fleet));
  const { outcome } = await hostCall(host, `/fleet/logs?source=${v.logSource}&lines=200`);
  v.busy = false;
  if (outcome.ok && typeof (outcome.data as { text?: unknown }).text === "string") {
    v.logText = (outcome.data as { text: string }).text || "(empty)";
    v.notice = `${host.name}: last lines of the ${v.logSource} log, read ${new Date().toLocaleTimeString()}.`;
  } else v.notice = `${host.name}: log not read: ${outcome.ok ? "malformed answer" : outcome.message}`;
  renderAdmin(selectedHostState(fleet));
}

const settingsTitles = { appearance: 'Appearance', terminal: 'Terminal', reviews: 'Reviews', navigation: 'Navigation', hosts: 'Hosts', about: 'About' };
let settingsSection: keyof typeof settingsTitles = 'appearance';
function preferenceField(key: Preference, label: string, hint: string) {
  const options = Object.entries(preferenceOptions[key]).map(([value, name]) => `<option value="${value}"${draftPrefs[key] === value ? ' selected' : ''}>${name}</option>`).join('');
  return `<label class="pref-field"><span><strong>${label}</strong><small>${hint}</small></span><select data-pref="${key}" data-fk="pref:${key}">${options}</select></label>`;
}
const studioTitles = { settings: 'Settings', workspaces: "Workspaces", dashboard: "Dashboard", tasks: "Tasks", decisions: "Decisions", activity: "Activity", fleet: "Fleet", terminals: "Terminals", machine: "Workstation" };
const initialParams = new URL(location.href).searchParams;
const initialView = initialParams.get('view');
let studioView: keyof typeof studioTitles = !initialParams.has('host') && initialView && initialView !== 'machine' && Object.hasOwn(studioTitles, initialView)
  ? initialView as keyof typeof studioTitles : 'dashboard';
let focusedPane: string | null = null;
let linkedSession: { host: string; name: string } | null = null;
let studioProject: string | null = null;
const localProjects = new Set<string>();
let visibleProjects: string[] = [];
let editingProject = false;
type SessionShortcut = { host: string; gen: number; name: string };
const shortcutKey = (s: SessionShortcut) => JSON.stringify([s.host, s.gen, s.name]);
const pinnedSessions = new Map<string, SessionShortcut>();
let lastVisitedSession: SessionShortcut | null = null;
let decisionsHost: string | null = null;
let decisionQueue: "pending" | "recorded" | "other" = "pending";
function renderStudio() {
  $('terminals').dataset.layout = preferences.layout;
  const hosts = fleet.order.map(id => fleet.hosts[id]!);
  const rows = hosts.flatMap(h => h.coordRead.status !== "ready" || h.info.supervisor ? [] : h.coord.requests.flatMap(q => {
    const owner = requestOwner(q);
    return typeof owner === "object" ? [{ h, q, owner }] : [];
  }));
  const runs = hosts.flatMap(h => h.coordRead.status !== 'ready' || h.info.supervisor ? [] : h.coord.runs.flatMap(run => {
    const owner = run && requestOwner(run);
    return owner && typeof owner === 'object' ? [{ h, owner, run }] : [];
  }));
  const projects = [...new Set([...localProjects, ...[...runs, ...rows].map(r => r.owner.project)])].sort();
  visibleProjects = projects;
  if (studioView !== 'workspaces') editingProject = false;
  $('projectEditor').hidden = !editingProject;
  const active = studioProject ?? projects[0];
  const picker = $('studioProjects') as HTMLSelectElement;
  setHtml(picker, '<option value="">All projects</option>' + [...new Set([...projects, ...(active ? [active] : [])])].map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join(''));
  picker.value = active ?? '';
  const scoped = active === '' ? rows : rows.filter(r => r.owner.project === active);
  const decisionQueues = { pending: scoped.filter(r => r.q.status === "open"), recorded: scoped.filter(r => r.q.status === "resolved" || r.q.status === "acknowledged"), other: scoped.filter(r => !["open", "resolved", "acknowledged"].includes(r.q.status)) };
  const queue = studioView === "dashboard" ? decisionQueues.pending : studioView === "decisions" ? decisionQueues[decisionQueue] : scoped;
  const machine = selectedHostState(fleet);
  if (studioView === 'decisions') {
    const row = queue.find(r => (!decisionsHost || decisionsHost === r.h.info.id) && (!reviewing || inReview(r.h, r.q)));
    const q = row?.q;
    $('workspaceInspectorTitle').textContent = q ? `${q.id} · revision ${q.revision}` : 'Supervisor receipt';
    $('workspaceInspectorText').textContent = !q ? 'No reported request in this queue.' : `${row!.h.info.name} · ${row!.owner.project} / ${row!.owner.task} · ${q.status === 'open' ? 'No decision yet' : q.status === 'resolved' ? `Recorded: ${q.response ?? 'response unavailable'} · Awaiting host acknowledgement` : requestLabel[q.status] ?? q.status}`;
  }
  const nav = $('workstationNav');
  nav.hidden = !machine || !!reviewing || (studioView !== 'machine' && studioView !== 'terminals');
  if (!nav.hidden && machine) {
    const configuration = manage && mode === 'gateway' ? `<a href="./workstation?host=${encodeURIComponent(machine.info.id)}">Configuration</a>` : '';
    setHtml(nav, `<div class="machine-title"><h1>${esc(machine.info.name)}</h1><small>${esc(machine.info.group ?? 'Ungrouped')} · ${esc(hostSubtitle(machine))}</small></div><div class="machine-tabs"><button type="button" data-view="machine" aria-current="${studioView === 'machine' ? 'page' : 'false'}" data-fk="machine:overview">Overview</button><button type="button" data-view="terminals" aria-current="${studioView === 'terminals' ? 'page' : 'false'}" data-fk="machine:terminals">Terminals</button>${configuration}</div>`);
  }
  const fleetQuery = studioView === 'fleet' ? ($('fleetQuery') as HTMLInputElement).value.trim().toLowerCase() : '';
  const groupControl = $('fleetGroup') as HTMLSelectElement;
  const groups = [...new Set(hosts.map(h => h.info.group ?? 'Ungrouped'))].sort();
  const group = groups.includes(groupControl.value) ? groupControl.value : '';
  setHtml(groupControl, '<option value="">All groups</option>' + groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join(''));
  groupControl.value = group;
  const readState = ($('fleetReadState') as HTMLSelectElement).value;
  const inventory = hosts.filter(h => (!group || (h.info.group ?? 'Ungrouped') === group) && (!readState || h.sessionsRead.status === readState) && (!fleetQuery || [h.info.name, h.info.id, h.info.group ?? 'Ungrouped'].some(value => value.toLowerCase().includes(fleetQuery))));
  const items = studioView === "fleet" || studioView === "machine" ? (studioView === "fleet" ? inventory : machine ? [machine] : []).map(h => `<button type="button" data-host="${esc(h.info.id)}"><strong>${esc(h.info.name)}</strong> <small>${esc(hostSubtitle(h))}</small></button>`).join("") : queue.map(({ h, q, owner }) => `<button type="button" data-open-task="1" data-review-request="${esc(String(q.id))}" data-host="${esc(h.info.id)}" data-project="${esc(owner.project)}" data-task="${esc(owner.task)}"><span class="decision-copy"><small>${esc(owner.project)} / ${esc(owner.task)} / rev ${esc(String(q.revision))}</small><strong>${esc(String(q.question))}</strong><small>${esc(h.info.name)} · ${esc(requestLabel[q.status] ?? String(q.status))}</small></span><span>Review →</span></button>`).join("");
  const partial = hosts.some(h => !h.info.supervisor && h.coordRead.status !== "ready");
  const badge = $('decisionBadge');
  badge.hidden = !decisionQueues.pending.length;
  badge.textContent = String(decisionQueues.pending.length);
  const currentView = reviewing ? "decisions" : studioView === "machine" ? "fleet" : studioView;
  for (const view of ["settings", "workspaces", "dashboard", "tasks", "decisions", "activity", "fleet", "terminals"]) {
    $("studioNavigation").querySelector(`[data-view="${view}"]`)?.setAttribute("aria-current", view === currentView ? "page" : "false");
  }
  const terminal = studioView === "terminals";
  $("fleetSearch").hidden = terminal || studioView !== 'fleet';
  $("activitySearch").hidden = terminal || studioView !== 'activity';
  $("studioContent").hidden = terminal;
  $("studioConsole").hidden = !terminal;
  const section = (label: string, title: string, body: string) => `<section class="studio-card"><small>${label}</small><h3>${title}</h3>${body}</section>`;
  let body = `<div class="studio-list">${items || (studioView === 'fleet' && (fleetQuery || group || readState) && hosts.length ? '<p>No matching workstations.</p>' : '<p>No items in the current view.</p>')}</div>`;
  if (studioView === 'workspaces') {
    const directory = new Map<string, { tasks: Set<string>; pending: number }>();
    for (const row of [...runs, ...rows]) {
      const entry = directory.get(row.owner.project) ?? { tasks: new Set<string>(), pending: 0 };
      entry.tasks.add(row.owner.task);
      if ('q' in row && (row.q as Req).status === 'open') entry.pending++;
      directory.set(row.owner.project, entry);
    }
    const entries = projects.map(p => {
      const entry = directory.get(p) ?? { tasks: new Set(), pending: 0 };
      return `<div class="workspace-entry"><div><strong>${esc(p)}</strong><small>${entry.tasks.size} ${entry.tasks.size === 1 ? 'task' : 'tasks'} · ${entry.pending} pending ${entry.pending === 1 ? 'decision' : 'decisions'}</small></div><button type="button" data-fk="workspace:${esc(p)}" data-workspace="${esc(p)}">Open workspace →</button></div>`;
    });
    body = `<section class="workspace-directory"><small>Project directory</small>${entries.join('') || '<p>No projects in the available run and request data.</p>'}</section>`;
  }
  $('fleetHeading').hidden = terminal || studioView !== 'fleet';
  if (studioView === 'fleet') {
    const add = mode === 'gateway' && enroll ? '<a data-fk="fleet:add" href="./add-host">+ Add host</a>' : '';
    setHtml($('fleetHeading'), `<div><small>Shared infrastructure</small><h1>Fleet</h1><p>Compare machines across all projects.</p></div>${add}`);
    const headings = ['Machine', 'Group', 'Session read', 'Last session read', 'Sessions', 'Open decisions', 'Console'];
    const records = inventory.map(h => {
      const meta = h.sessionsRead;
      const stamp = meta.at && Number.isFinite(Date.parse(meta.at)) ? esc(meta.at) : 'Unavailable';
      const sessions = meta.status === 'ready' ? String(h.sessions.length) : meta.at ? `${h.sessions.length} last known` : 'Unknown';
      const decisions = h.info.supervisor || h.coordRead.status !== 'ready' ? 'Unknown' : String(h.coord.requests.filter(q => q.status === 'open').length);
      const id = esc(h.info.id), name = esc(h.info.name);
      const decisionLink = decisions === 'Unknown' ? decisions : `<button data-fk="decisions:${id}" data-decisions-host="${id}" aria-label="Show ${decisions} open decisions on ${name}">${decisions}</button>`;
      const time = stamp === 'Unavailable' ? stamp : `<time datetime="${stamp}" title="${stamp}">${esc(clock(stamp))}</time>`;
      return `<tr><th scope="row"><button data-fk="inventory:${id}" data-host="${id}">${name}</button><small>${id}</small></th><td>${esc(h.info.group ?? 'Ungrouped')}</td><td>${meta.status === 'ready' ? 'Ready' : meta.status === 'unknown' ? 'Read failed' : 'Loading'}</td><td>${time}</td><td>${sessions}</td><td>${decisionLink}</td><td><button data-fk="console:${id}" data-host="${id}" data-console-host="${id}" aria-label="Open terminals on ${name}">Terminals ↗</button></td></tr>`;
    });
    const empty = hostListError || (hosts.length ? 'No matching workstations.' : 'Reading workstation inventory.');
    body = `<div class="studio-inventory"><table aria-label="Workstation inventory"><thead><tr>${headings.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${records.join('') || `<tr><td colspan="7">${esc(empty)}</td></tr>`}</tbody></table></div>`;
  }
  type ProjectRow = typeof scoped[number];
  const rowContext = (owner: ProjectRow['owner'], revision?: number) => `${esc(owner.project)} / ${esc(owner.task)}${Number.isInteger(revision) ? ' / rev ' + revision : ''}`;
  const rowReview = (h: HostState, owner: ProjectRow['owner'], request?: Req) => `<button type="button" data-open-task="1" data-host="${esc(h.info.id)}" data-project="${esc(owner.project)}" data-task="${esc(owner.task)}"${request ? ` data-review-request="${esc(request.id)}"` : ''} aria-label="Review ${rowContext(owner)}${request ? ': ' + esc(request.question) : ''}">Review →</button>`;
  const projectRow = (context: string, title: string, meta: string, action: string, focusId?: string) => `<div class="project-row"${focusId ? ` id="${esc(focusId)}" tabindex="-1"` : ''}><div><small>${context}</small><h3>${title}</h3>${meta ? `<small>${meta}</small>` : ''}</div>${action}</div>`;
  const projectBox = (content: string) => `<section class="project-box">${content}</section>`;
  if (studioView === "decisions") {
    const filters = ([['pending', 'Pending'], ['recorded', 'Recorded'], ['other', 'Other statuses']] as const).filter(([key]) => key !== 'other' || decisionQueues.other.length || key === decisionQueue);
    const cards = queue.filter(({h}) => !decisionsHost || h.info.id === decisionsHost).map(({ h, q, owner }) => {
      const run = h.coord.runs.find(r => r.id === q.runId && r.projectId === owner.project && r.taskId === owner.task);
      const status = q.status === 'open' && q.kind === 'approval' ? 'Waiting for approval' : requestLabel[q.status] ?? q.status;
      const source = reportedSession(q, run);
      return projectRow(rowContext(owner, q.revision), esc(q.question), `${esc(h.info.name)}${source ? ' / ' + esc(source) : ''} · ${esc(status)}`, rowReview(h, owner, q));
    });
    if (decisionsHost && active === '' && decisionQueue === 'pending') {
      const h = fleet.hosts[decisionsHost];
      if (h?.coordRead.status === 'ready' && !h.info.supervisor) for (const q of h.coord.requests) {
        if (q.status === 'open' && requestOwner(q) === 'none') cards.push(projectRow('No project assigned', esc(q.question), esc(h.info.name), `<button data-open-task="1" data-host="${esc(h.info.id)}" data-unassigned="1" data-review-request="${esc(q.id)}">Review →</button>`));
      }
    }
    const hostFilter = decisionsHost ? `<button type="button" data-clear-decisions-host="1">Workstation: ${esc(fleet.hosts[decisionsHost]?.info.name ?? decisionsHost)} ×</button>` : '';
    body = `<div class="project-page">${hostFilter}<nav class="project-queues" aria-label="Decision queues">${filters.map(([key, title]) => `<button type="button" data-decision-queue="${key}" aria-pressed="${key === decisionQueue}">${title}</button>`).join('')}</nav>${projectBox(cards.join('') || '<p>No matching requests.</p>')}</div>`;
  }
  const events = (studioView === "activity" || studioView === "dashboard" ? scoped : []).flatMap(({ h, owner, q }) => ([
    { label: "Request opened", at: q.createdAt }, { label: "Decision recorded", at: q.resolvedAt },
  ]).flatMap(({ label, at }) => typeof at === "string" && Number.isFinite(Date.parse(at)) ? [{ time: Date.parse(at), at, label, h, owner, q, text: `${at} ${label} ${owner.task} ${h.info.name} ${q.question}`.toLowerCase() }] : [])).sort((a, b) => b.time - a.time);
  const query = studioView === 'activity' ? ($('activityQuery') as HTMLInputElement).value.trim().toLowerCase() : '';
  if (studioView === 'activity') {
    const timeline = events.flatMap(({ at, label, owner, h, q, text }) => {
      const title = label === 'Request opened' && q.kind === 'approval' ? 'Requested approval' : label === 'Decision recorded' && q.response ? `${label}: ${q.response}` : label;
      if (query && !`${text} ${owner.project} ${title}`.toLowerCase().includes(query)) return [];
      const clock = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      return [projectRow(rowContext(owner, q.revision), `<span title="${esc(`${label}: ${q.question} (${h.info.name})`)}">${esc(title)}</span>`, '', `<time datetime="${esc(at)}" title="${esc(at)}">${esc(clock)}</time>`)];
    });
    body = `<div class="project-page project-events">${timeline.join('') || (events.length ? '<p>No matching events.</p>' : '<p>No dated events in the current requests.</p>')}</div>`;
  }
  if (studioView === 'machine' && !machine) body = `<p>${esc(hostListError || 'Reading workstation inventory.')}</p>`;
  if (studioView === "machine" && machine) {
    const h = machine, id = esc(h.info.id);
    const prefs = h.info.defaultHarness === "deepseek-harness" ? "DeepSeek Harness" : h.info.defaultHarness === "claude-code" ? "Claude Code" : "No preference reported";
    const sessions = h.sessions.map(s => {
      const pinned = pinnedSessions.has(shortcutKey({ host: h.info.id, gen: h.gen, name: s.name }));
      return `<div><button type="button" data-fk="session:${id}:${esc(s.name)}" data-host="${id}" data-session="${esc(s.name)}"><strong>${esc(s.name)}</strong> · ${esc(modelLabel(s.model))}</button><button type="button" data-fk="pin:${id}:${esc(s.name)}" data-host="${id}" data-pin-session="${esc(s.name)}" aria-label="Pin ${esc(s.name)}" aria-pressed="${pinned}"${h.sessionsRead.status !== 'ready' ? ' disabled' : ''}>${pinned ? 'Unpin' : 'Pin'}</button></div>`;
    }).join("");
    const readAt = h.sessionsRead.at;
    const lastRead = readAt && Number.isFinite(Date.parse(readAt)) ? `<time datetime="${esc(readAt)}" title="Last successful session read: ${esc(readAt)}">Session read · ${esc(clock(readAt))}</time>` : 'Session read time unavailable';
    const tasks = new Map<string, string>();
    for (const row of [...rows, ...runs]) {
      if (row.h !== h) continue;
      const { project, task } = row.owner, key = JSON.stringify([project, task]);
      if (tasks.has(key)) continue;
      const run = 'run' in row ? row.run : h.coord.runs.find(r => r.id === row.q.runId && r.projectId === project && r.taskId === task);
      const revision = 'q' in row ? row.q.revision : row.run.revision;
      const source = reportedSession('q' in row ? row.q : undefined, run);
      const terminal = source && h.sessionsRead.status === 'ready' && h.sessions.some(s => s.name === source && s.running) ? `<button data-host="${id}" data-session="${esc(source)}" data-fk="focus:${esc(key)}">Focus terminal ↗</button>` : '';
      tasks.set(key, `<div class="machine-work-row"><div><small>${esc(project)} / ${esc(task)}${Number.isInteger(revision) ? ` · revision ${revision}` : ''}</small><h3>${esc('q' in row ? row.q.question : task)}</h3><small>${esc(source || 'Session not reported')}</small></div><div class="machine-actions"><button data-fk="task:${esc(key)}" data-host="${id}" data-project="${esc(project)}" data-task="${esc(task)}" data-machine-task="1">Open project task</button>${terminal}</div></div>`);
    }
    const workReadable = !h.info.supervisor && h.coordRead.status === 'ready';
    const workEmpty = workReadable ? 'No assigned tasks in the current runs or requests.' : 'Project work data unavailable.';
    const unassignedCount = workReadable ? h.coord.requests.filter(q => q.status === 'open' && requestOwner(q) === 'none').length : 0;
    const unassigned = unassignedCount ? `<p>${unassignedCount} open without a project or task. <button data-host="${id}" data-unassigned="1">Review unassigned decisions</button></p>` : '';
    body = `<section class="machine-status" aria-label="Machine status"><div><b>Machine status</b><small>${lastRead}</small></div><div><small>Disk · workspace</small><b>Not reported</b></div><div><small>Memory</small><b>Not reported</b></div><div><small>Harness preference</small><b>${prefs}</b></div><div><small>Observed harness</small><b>Not reported</b></div></section>`
      + `<section class="machine-work" id="machineWork" data-fk="machine-work:${id}" tabindex="-1"><small>Project → Task → Session</small><h2>Work on this machine</h2>${[...tasks.values()].join('') || `<p>${workEmpty}</p>`}${unassigned}</section>`
      + `<section class="machine-sessions"><h2>Sessions on this workstation</h2>${h.sessionsRead.status !== 'ready' ? '<p>Current session state unknown. Any sessions shown are last known.</p>' : ''}${sessions || (h.sessionsRead.status === 'ready' ? '<p>No sessions reported.</p>' : '')}</section>`;
  }
  if (studioView === "tasks") {
    type Task = Pick<ProjectRow, 'h' | 'owner'> & { requests: Req[]; runs: HostState['coord']['runs'] };
    const tasks = new Map<string, Task>();
    const taskFor = ({ h, owner }: Pick<ProjectRow, 'h' | 'owner'>) => {
      const key = JSON.stringify([h.info.id, owner.project, owner.task]);
      if (!tasks.has(key)) tasks.set(key, { h, owner, requests: [], runs: [] });
      return tasks.get(key)!;
    };
    for (const row of scoped) taskFor(row).requests.push(row.q);
    for (const row of runs) if (active === '' || row.owner.project === active) taskFor(row).runs.push(row.run);
    const cards = Array.from(tasks.values(), ({ h, owner, requests, runs }) => {
      const request = requests.length === 1 ? requests[0] : undefined;
      const run = request ? runs.find(r => r.id === request.runId) : runs.length === 1 ? runs[0] : undefined;
      const status = !requests.length ? 'No current decisions' : request ? (request.status === 'open' && request.kind === 'approval' ? 'Waiting for approval' : requestLabel[request.status] ?? request.status) : `${requests.filter(q => q.status === 'open').length} open of ${requests.length} decisions`;
      const source = reportedSession(request, run);
      return projectRow(rowContext(owner, request?.revision ?? run?.revision), esc(owner.task), `${esc(h.info.name)}${source ? ' / ' + esc(source) : ''} · ${esc(status)}`, requests.length ? rowReview(h, owner, request) : '', 'studio-task-' + JSON.stringify([h.info.id, owner.project, owner.task]));
    });
    body = `<div class="project-page">${projectBox(cards.join('') || '<p>No tasks in the available run and request data.</p>')}</div>`;
  }
  if (studioView === "dashboard") {
    const needsAttention = hosts.filter(h => h.sessionsRead.status !== "ready");
    const shortcuts = new Map(pinnedSessions);
    if (lastVisitedSession) shortcuts.set(shortcutKey(lastVisitedSession), lastVisitedSession);
    const quick = Array.from(shortcuts, ([key, target]) => {
      const source = fleet.hosts[target.host];
      if (!source || source.gen !== target.gen || source.sessionsRead.status !== 'ready' || !source.sessions.some(s => s.name === target.name)) return '';
      return `<button data-host="${esc(target.host)}" data-session="${esc(target.name)}"><small>${pinnedSessions.has(key) ? 'Pinned' : 'Last viewed'}</small> ${esc(source.info.name)} / ${esc(target.name)}</button>`;
    }).join(' ');
    const taskLinks = new Map<string, string>();
    const approvalRows: string[] = [];
    const requestTime = (q: Req) => { const time = Date.parse(q.createdAt ?? ''); return Number.isFinite(time) ? time : Infinity; };
    for (const { h, owner, q } of [...scoped].sort((a, b) => requestTime(a.q) - requestTime(b.q) || a.owner.task.localeCompare(b.owner.task) || a.q.id.localeCompare(b.q.id))) {
      const run = h.coord.runs.find(run => run.id === q.runId && run.projectId === owner.project && run.taskId === owner.task);
      const source = reportedSession(q, run);
      const session = source && h.sessionsRead.status === 'ready' && h.sessions.some(s => s.name === source && s.running) ? source : null;
      const context = `${esc(owner.project)} / ${esc(owner.task)}`;
      const taskTarget = `data-open-task="1" data-host="${esc(h.info.id)}" data-project="${esc(owner.project)}" data-task="${esc(owner.task)}"`;
      const target = session ? `data-host="${esc(h.info.id)}" data-session="${esc(session)}"` : taskTarget;
      const key = JSON.stringify([h.info.id, owner.project, owner.task, session]);
      taskLinks.set(key, `<button type="button" ${target} title="${session ? 'Open terminal' : 'Review task'}: ${esc(h.info.name)}${session ? ' / ' + esc(session) : ''}">${context} ↗</button>`);
      if (q.status === 'open') approvalRows.push(`<div class="dashboard-row"><div><small>${context} / rev ${esc(String(q.revision))}</small><h3>${esc(String(q.question))}</h3><small>${esc(h.info.name)}${source ? ' / ' + esc(source) : ''} · ${q.kind === 'approval' ? 'Waiting for approval' : 'Waiting for a decision'}</small></div><button type="button" ${taskTarget} data-review-request="${esc(q.id)}" aria-label="Review ${context}: ${esc(String(q.question))}">Review →</button></div>`);
    }
    const health = needsAttention.map(h => `<button type="button" data-host="${esc(h.info.id)}">${esc(h.info.name)} · ${esc(hostSubtitle(h))}</button>`).join(' ');
    const unassigned = hosts.filter(h => !h.info.supervisor && h.coordRead.status === 'ready').map(h => {
      const count = h.coord.requests.filter(q => q.status === 'open' && requestOwner(q) === 'none').length;
      return count ? `<button type="button" data-open-task="1" data-unassigned="1" data-host="${esc(h.info.id)}">${esc(h.info.name)} · ${count} unassigned request${count === 1 ? '' : 's'} · Review →</button>` : '';
    }).join('');
    const recentEvents = events.slice(0, 3);
    const visibleReceipts = new Set(recentEvents.filter(e => e.label === 'Decision recorded').map(e => e.q));
    const receipts = scoped.filter(r => r.q.status === 'resolved' && !visibleReceipts.has(r.q)).map(({ q, owner }) => `<p class="studio-receipt"><strong>${esc(owner.task)} · ${esc(String(q.response ?? "Decision recorded"))}</strong><br>Awaiting host acknowledgement</p>`).join("");
    const box = (title: string, content: string) => `<section class="dashboard-box"><h2>${title}</h2>${content}</section>`;
    const summary = `${queue.length} ${queue.length === 1 ? 'decision needs' : 'decisions need'} your attention`;
    const approval = box('Needs your decision', approvalRows.join('') || '<p>No open decisions in the available project data.</p>');
    const activity = recentEvents.map(({ owner, q, label, at }) => {
      const outcome = q.response === 'approve' ? 'Approved' : q.response === 'decline' ? 'Declined' : q.response ? `Decision recorded: ${esc(String(q.response))}` : 'Decision recorded';
      const title = label === 'Decision recorded' ? outcome + (q.status === 'resolved' ? ' · Awaiting host acknowledgement' : '') : q.kind === 'approval' ? 'Requested approval' : label;
      const clock = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      return `<div class="dashboard-row"><div><small>${esc(owner.project)} / ${esc(owner.task)} / rev ${esc(String(q.revision))}</small><h3>${title}</h3></div><time datetime="${esc(at)}" title="${esc(at)}">${esc(clock)}</time></div>`;
    }).join('');
    const links = [...taskLinks.values(), quick].filter(Boolean).join(' ');
    const resume = box('Return to work', `<div class="dashboard-links">${links || '<button type="button" data-view="terminals">Open terminals →</button>'}</div><hr><h3>Shared fleet</h3>${health || (hosts.length ? '<button type="button" data-view="fleet">Inspect workstations</button>' : '<p>No workstations connected.</p>')}`);
    body = `<div class="studio-dashboard" role="region" aria-label="${summary}">${approval}<div class="dashboard-grid">${box('Recent activity', activity || '<p>No dated events in the current requests.</p>')}${resume}</div>${unassigned ? box('No project assigned', unassigned) : ''}${receipts ? box('Recorded decisions', receipts) : ''}</div>`;
  }
  if (studioView === 'settings') {
    const tabs = `<nav class="studio-settings-tabs" aria-label="Settings sections">${Object.entries(settingsTitles).map(([key, label]) => `<button type="button" data-settings-section="${key}" data-fk="settings:${key}" aria-current="${settingsSection === key ? 'page' : 'false'}">${label}</button>`).join('')}</nav>`;
    const row = (key: string, value: string) => `<div class="pref-row"><div>${key}</div><div>${value}</div></div>`;
    let panel: string;
    switch (settingsSection) {
      case 'appearance': panel = '<h2>Workspace appearance</h2><p>Set the contrast and information density.</p>' + preferenceField('theme', 'Theme', 'Applies to the workspace, not the terminal palette.') + preferenceField('byline', 'View descriptions', 'Show or hide the subtitle below each workspace title.'); break;
      case 'terminal': panel = '<h2>Ghostty terminal</h2><p>Tune the actual terminal reading surface.</p>' + preferenceField('font', 'Terminal font size', 'Pixels. Preview below before applying.') + preferenceField('layout', 'Host terminal layout', 'On desktop, arrange sessions across or down the workspace.') + `<pre class="pref-preview" style="font-size:${draftPrefs.font}px">Font preview\nGATE   Awaiting operator decision</pre>`; break;
      case 'reviews': panel = '<h2>Review requests</h2><p>Control how a request opens over the console.</p>' + preferenceField('evidence', 'Evidence on open', 'This changes disclosure only, never approval or execution.'); break;
      case 'navigation': panel = '<h2>Host navigation</h2><p>Choose how host groups appear when you apply your preferences.</p>' + preferenceField('groups', 'Session lists', 'Individual groups can still be expanded in the sidebar.'); break;
      case 'hosts': panel = '<h2>Host configuration</h2>' + (mode === 'gateway' && enroll ? '<a class="pref-link" href="./add-host">+ Add host</a>' : '') + '<p>Host settings are separate from application preferences.</p>' + (hosts.map(h => row(`<strong>${esc(h.info.name)}</strong><br><small>${esc(h.info.id)}</small>`, mode === 'gateway' && manage ? `<a class="pref-link" href="./workstation?host=${encodeURIComponent(h.info.id)}">Configure host</a>` : `<button type="button" data-host="${esc(h.info.id)}">View host</button>`)).join('') || '<p>No workstations in the available host list.</p>'); break;
      case 'about': panel = '<h2>Diagnostics</h2><p>Console runtime and connection boundaries.</p>' + row('Renderer', 'ghostty-web 0.4.0') + row('Terminal transport', 'WebSocket') + row('Host connection', mode === 'gateway' ? 'Client gateway' : mode === 'direct' ? 'Host service' : 'Not established') + row('Preference storage', 'In memory until reload'); break;
    }
    const disabled = preferencesDirty() ? '' : ' disabled';
    const category = settingsSection === 'hosts' ? 'Per host' : settingsSection === 'about' ? 'Read only' : 'Operator preferences';
    setHtml($('studioContent'), `<div class="studio-preferences"><header class="studio-pagehead"><small>Workspace / Preferences</small><h1>Settings</h1><p>Manage your console, review workflow and host connections.</p></header>${tabs}<section class="pref-panel"><small class="pref-cap">${category}</small>${panel}<div class="pref-actions"><button type="button" data-apply-prefs="1"${disabled}>Apply changes</button><button type="button" data-discard-prefs="1"${disabled}>Discard</button><span role="status">${preferencesDirty() ? 'Unapplied changes' : preferenceStatus}</span></div><p class="pref-scope">Workspace preferences only. No credentials, permissions or host processes are changed.</p></section><button type="button" data-view="terminals">Back to console</button></div>`);
    return;
  }
  if (['workspaces', 'tasks', 'decisions', 'activity'].includes(studioView)) {
    const scopeNote = '<p class="studio-scope">Based on current host reports. Older runs and decisions may not appear.</p>';
    body += scopeNote;
  }
  if (studioView === 'machine' || studioView === 'fleet') {
    setHtml($('studioContent'), body);
    return;
  }
  const caption = ['fleet', 'machine'].includes(studioView) ? 'Shared infrastructure' : studioView === 'workspaces' ? 'Operator workspace' : `Project workspace${active === '' ? ' / All projects' : active ? ' / ' + esc(active) : ''}`;
  const pagehead = studioView === 'workspaces' ? `<header class="studio-pagehead workspace-directory-head"><div><small>Operator workspace / Projects</small><h1>Workspaces</h1><p>One project per workspace. Hosts are shared; tasks and decisions belong to their project.</p></div><button type="button" data-new-project="1">+ New project</button></header>` : `<header class="studio-pagehead"><small>${caption}</small><h1>${studioTitles[studioView]}</h1></header>`;
  setHtml($("studioContent"), `${pagehead}${partial ? '<p>Some host data is unavailable or still loading.</p>' : ''}${body}`);
}
function render() {
  const h = selectedHostState(fleet);
  renderAgents(h);
  renderAdmin(h);
  renderChrome(h);
  renderNav();
  renderPanes(h);
  renderRequests(h);
  renderWorkflow(h);
  renderExchange(h);
  renderComposer(h);
  renderStudio();
}

// --- reading ---------------------------------------------------------------------------------------

// Each read is tied to the host that started it; finishRead drops it if that read is no longer current.
async function refresh(hostId: string, kind: ReadKind) {
  const current = fleet.hosts[hostId];
  if (kind === "coord" && current?.info.supervisor) {
    if (current.commandsRead.status === "loading") await readCooperativePage(hostId, "commands");
    return;
  }
  const begun = beginRead(fleet, hostId, kind);
  if (!begun.token) return;
  apply(begun.fleet);
  const host = fleet.hosts[hostId]!.info;
  let result: Outcome<any>;
  if (kind === "sessions") {
    const { outcome } = await hostCall(host, "/sessions");
    result = outcome.ok ? parseSessions(outcome.data) : outcome;
  } else {
    // Only what is shown is read. A host released before latest= and view= answers 400; then read the whole list.
    const [current, newest] = await Promise.all([hostCall(host, "/requests?view=current"), hostCall(host, `/commands?latest=${SHOWN_COMMANDS}`)]);
    const [rq, cm] = await Promise.all([
      current.status === 400 ? hostCall(host, "/requests") : current,
      newest.status === 400 ? hostCall(host, "/commands") : newest,
    ]);
    result = parseCoord(rq.outcome, cm.outcome);
  }
  apply(finishRead(fleet, hostId, kind, begun.token, result, new Date().toISOString()));
  if (kind === 'sessions' && linkedSession?.host === hostId) {
    const name = linkedSession.name; linkedSession = null;
    const current = selectedHostState(fleet);
    if (studioView === 'terminals' && current?.info.id === hostId && current.sessionsRead.status === 'ready' && current.sessions.some(s => s.name === name)) {
      apply(selectSession(fleet, hostId, name)); focusedPane = name;
    }
  }
  render();
}
async function readCooperativePage(hostId: string, kind: "commands" | "inspection", more = false) {
  const begun = beginPageRead(fleet, hostId, kind, more);
  if (!begun.handle) return;
  apply(begun.fleet);
  const a = begun.handle;
  const host = fleet.hosts[hostId]!.info;
  render();
  const query = a.cursor ? '?cursor=' + encodeURIComponent(a.cursor) : '';
  const path = kind === 'commands' ? '/commands' : '/commands/' + encodeURIComponent(a.commandId) + '/cooperative';
  const { outcome } = await hostCall(host, path + query);
  const result = outcome.ok ? kind === 'commands' ? parseCommandPage(outcome.data, host, a.cursor) : parseInspection(outcome.data, host, a.commandId, a.cursor) : outcome;
  apply(finishPageRead(fleet, a, result, new Date().toISOString()));
  render();
}
const refreshAll = (kind: ReadKind) => Promise.all(fleet.order.map((id) => refresh(id, kind)));

let hostListBusy = false;
let initialLocationRead = false;
async function loadHostList() {
  if (hostListBusy) return;
  hostListBusy = true;
  try {
    const res = await fetch("./api/hosts", { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (res.status === 401) { location.assign("./login"); return; }
    const body = res.ok ? await res.json().catch(() => null) : null;
    const list = parseHostList(body);
    if (!list) { hostListError = `Cannot read the host list (${res.status}). Host state is unknown.`; render(); return; }
    mode = list.mode;
    installer = body.installer === true;
    enroll = body.enroll === true;
    manage = body.manage === true;
    hostListError = list.hosts.length ? "" : enroll ? "No hosts yet. Use Add a host in the host tree." : "The gateway lists no hosts.";
    peers = list.peers;
    apply(setHosts(fleet, list.hosts));
    if (!initialLocationRead) {
      initialLocationRead = true;
      const host = initialParams.get('host'), view = initialView;
      if (host && fleet.order.includes(host) && (view === 'machine' || view === 'terminals')) {
        apply(selectHost(fleet, host)); studioView = view;
        const session = initialParams.get('session');
        if (view === 'terminals' && session) linkedSession = { host, name: session };
      }
    }
    render();
    // Hosts are read concurrently; a failing host does not delay the others.
    void refreshAll("sessions");
    void refreshAll("coord");
    for (const id of fleet.order) void refreshAgents(id);
    for (const id of fleet.order) void refreshAdmin(id);
  } catch {
    hostListError = "Cannot reach the host list. Host state is unknown.";
    render();
  } finally {
    hostListBusy = false;
  }
}

// --- interaction -----------------------------------------------------------------------------------

let navigationOpen = false;
function setNavigation(open: boolean, restoreFocus = false) {
  const toggle = $('navigationToggle');
  const wasOpen = navigationOpen;
  navigationOpen = open;
  $('app').classList.toggle('navigation-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  if (open) $('studioNavigation').querySelector<HTMLElement>('[data-view="workspaces"]')?.focus();
  else if (restoreFocus && wasOpen) toggle.focus();
}
$('studioNavigation').addEventListener('keydown', e => {
  if (e.key === 'Escape' && navigationOpen) { e.stopPropagation(); setNavigation(false, true); }
});
$('workspaceInspectorToggle').addEventListener('keydown', e => {
  if (e.key === 'Escape' && workspaceInspectorOpen) {
    e.stopPropagation(); workspaceInspectorOpen = false; renderChrome(selectedHostState(fleet));
  }
});
document.addEventListener("click", (e) => {
  const b = (e.target as Element).closest("button");
  if (!b) return;
  if (b.id === 'navigationToggle') { setNavigation(!navigationOpen); return; }
  if (b.id === 'workspaceInspectorToggle') {
    workspaceInspectorOpen = !workspaceInspectorOpen; renderChrome(selectedHostState(fleet)); return;
  }
  if (b.dataset.view || b.dataset.host) setNavigation(false, true);
  if (b.dataset.pinSession) {
    const h = selectedHostState(fleet), name = b.dataset.pinSession;
    if (studioView === 'machine' && h && h.info.id === b.dataset.host && h.sessionsRead.status === 'ready' && h.sessions.some(s => s.name === name)) {
      const target = { host: h.info.id, gen: h.gen, name }, key = shortcutKey(target);
      if (!pinnedSessions.delete(key)) pinnedSessions.set(key, target);
      renderStudio();
    }
    return;
  }
  if (b.dataset.toggleHost) {
    const id = b.dataset.toggleHost;
    hostDisclosures.set(id, !(hostDisclosures.get(id) ?? (id === fleet.selectedHost && preferences.groups !== 'collapsed')));
    renderNav(); return;
  }
  if (b.dataset.toggleGroup) {
    const group = b.dataset.toggleGroup;
    if (!collapsedGroups.delete(group)) collapsedGroups.add(group);
    renderNav(); return;
  }
  if (studioView === 'settings' && preferencesDirty()) {
    if (b.dataset.discardPrefs) { draftPrefs = { ...preferences }; preferenceStatus = 'Changes discarded'; renderStudio(); return; }
    if (b.dataset.applyPrefs) {
      if (preferences.font !== draftPrefs.font) for (const pane of panes.values()) pane.setFontSize(Number(draftPrefs.font));
      if (preferences.groups !== draftPrefs.groups) for (const id of fleet.order) hostDisclosures.set(id, draftPrefs.groups === 'expanded');
      Object.assign(preferences, draftPrefs);
      applyAppearance(document.documentElement, preferences);
      preferenceStatus = savePreferences(preferences) ? 'Preferences applied' : 'Preferences applied for this page; tab storage unavailable.'; renderNav(); renderStudio(); return;
    }
  }
  if (studioView === 'settings' && b.dataset.settingsSection && Object.hasOwn(settingsTitles, b.dataset.settingsSection)) { settingsSection = b.dataset.settingsSection as keyof typeof settingsTitles; renderStudio(); return; }
  if (b.dataset.newProject && studioView === 'workspaces') {
    editingProject = true; ($('projectName') as HTMLInputElement).value = ''; $('projectError').textContent = ''; renderStudio(); $('projectName').focus(); return;
  }
  if (b.dataset.cancelProject) { editingProject = false; renderStudio(); return; }
  if (b.dataset.decisionsHost && fleet.order.includes(b.dataset.decisionsHost)) { decisionsHost = b.dataset.decisionsHost; studioProject = ''; studioView = 'decisions'; decisionQueue = 'pending'; reviewing = null; render(); return; }
  if (b.dataset.clearDecisionsHost) { decisionsHost = null; render(); return; }
  if (b.dataset.view && Object.hasOwn(studioTitles, b.dataset.view)) { decisionsHost = null; focusedPane = null; reviewing = null; studioView = b.dataset.view as keyof typeof studioTitles; render(); return; }
  if (studioView === "decisions" && (b.dataset.decisionQueue === "pending" || b.dataset.decisionQueue === "recorded" || b.dataset.decisionQueue === "other")) { decisionQueue = b.dataset.decisionQueue; render(); return; }
  if (b.dataset.workspace) { decisionQueue = "pending"; reviewing = null; studioProject = b.dataset.workspace; studioView = "dashboard"; render(); return; }
  if (b.dataset.openTask && b.dataset.host !== fleet.selectedHost && b.dataset.host && fleet.hosts[b.dataset.host]) {
    for (const v of adminViews.values()) v.newToken = "";
    apply(selectHost(fleet, b.dataset.host));
  }
  if (b.dataset.page) {
    const hostId = b.dataset.host!;
    if (b.dataset.page === "select") { apply(selectCommand(fleet, hostId, b.dataset.command!)); void readCooperativePage(hostId, "inspection"); }
    else void readCooperativePage(hostId, b.dataset.page === "inspect" || b.dataset.page === "events" ? "inspection" : "commands", b.dataset.page === "events" || b.dataset.page === "commands");
    return;
  }
  if (b.dataset.stop) { void stopAgent(b.dataset.host!, b.dataset.stop); return; }
  if (b.dataset.closeReview) { reviewing = null; render(); return; }
  if (b.dataset.machineTask && studioView === 'machine' && b.dataset.host === fleet.selectedHost && b.dataset.project && b.dataset.task) {
    studioProject = b.dataset.project; reviewing = null; studioView = 'tasks'; render();
    document.getElementById('studio-task-' + JSON.stringify([b.dataset.host, b.dataset.project, b.dataset.task]))?.focus();
    return;
  }
  if (b.dataset.project && b.dataset.task && b.dataset.host === fleet.selectedHost) {
    reviewing = { host: b.dataset.host, requestId: b.dataset.reviewRequest, owner: { project: b.dataset.project, task: b.dataset.task } }; render(); return;
  }
  if (b.dataset.unassigned && b.dataset.host === fleet.selectedHost) { reviewing = { host: b.dataset.host, owner: null, requestId: b.dataset.reviewRequest }; render(); return; }
  if (b.dataset.answer) {
    // Sent only for a request the open review shows, as it was last read: same host, owner, revision, still open.
    const h = selectedHostState(fleet);
    const q = h?.coord.requests.find((q) => q.id === b.dataset.request);
    if (h && q && h.coordRead.status === "ready" && b.dataset.host === h.info.id && inReview(h, q)
      && q.revision === Number(b.dataset.revision) && q.status === "open" && q.allowedResponses.includes(b.dataset.answer)) void answer(h.info.id, q.id, b.dataset.answer, q.revision);
    return;
  }
  if (b.id === "inspectorToggle") { setInspector(!inspectorOpen); return; }
  if (b.dataset.host && b.dataset.session) {
    studioView = "terminals"; reviewing = null;
    if (b.dataset.host !== fleet.selectedHost) for (const v of adminViews.values()) v.newToken = "";
    apply(selectSession(fleet, b.dataset.host, b.dataset.session));
    const visited = selectedHostState(fleet);
    focusedPane = visited?.info.id === b.dataset.host && visited.selectedSession === b.dataset.session ? b.dataset.session : null;
    if (visited?.info.id === b.dataset.host && visited.selectedSession === b.dataset.session) lastVisitedSession = { host: visited.info.id, gen: visited.gen, name: visited.selectedSession };
    render();
  } else if (b.dataset.host) {
    focusedPane = null;
    studioView = b.dataset.consoleHost === b.dataset.host ? 'terminals' : 'machine'; reviewing = null;
    // A token shown after a rotate is for that moment only; picking a host clears every shown token.
    for (const v of adminViews.values()) v.newToken = "";
    apply(selectHost(fleet, b.dataset.host));
    render();
    // The host may have been off screen for a while; read it again now.
    void refresh(b.dataset.host, "sessions");
    void refresh(b.dataset.host, "coord");
    void refreshAgents(b.dataset.host);
    void refreshAdmin(b.dataset.host);
  }
});

// The form draft belongs to the selected host, like the instruction draft.
for (const [id, key] of [["agentName", "name"], ["agentKind", "kind"], ["agentFolder", "cwd"], ["agentModel", "model"], ["agentPrompt", "prompt"], ["agentConfirm", "confirm"]] as const) {
  const onEdit = () => {
    const h = selectedHostState(fleet);
    if (!h) return;
    const form = agentView(h.info.id).form;
    const value = ($(id) as HTMLInputElement).value;
    // The kind comes from a picker filled with known kinds; anything else is ignored.
    if (key === "kind") { if (Object.hasOwn(KIND_LABEL, value)) form.kind = value as AgentKind; }
    else form[key] = value;
    renderAgents(h);
  };
  // A select reports a pick with change; some browsers and automation send no input event for it.
  $(id).addEventListener("input", onEdit);
  $(id).addEventListener("change", onEdit);
}

// Fleet section edits belong to the selected host.
const adminField = (id: string, set: (v: AdminView, value: string) => void) => {
  const onEdit = () => {
    const h = selectedHostState(fleet);
    if (!h) return;
    set(adminView(h.info.id), ($(id) as HTMLInputElement).value);
    renderAdmin(h);
  };
  $(id).addEventListener("input", onEdit);
  $(id).addEventListener("change", onEdit);
};
adminField("confText", (v, x) => { v.draft = x; });
adminField("confConfirm", (v, x) => { v.saveConfirm = x; });
adminField("restartSession", (v, x) => { v.restartSession = x; v.restartConfirm = ""; });
adminField("restartConfirm", (v, x) => { v.restartConfirm = x; });
adminField("startCommand", (v, x) => { v.startCommand = x; });
adminField("startCwd", (v, x) => { v.startCwd = x; });
adminField("startConfirm", (v, x) => { v.startConfirm = x; });
$("startSave").addEventListener("click", () => { const h = selectedHostState(fleet); if (h) void changeStart(h.info.id, false); });
$("startRemove").addEventListener("click", () => { const h = selectedHostState(fleet); if (h) void changeStart(h.info.id, true); });
adminField("logSource", (v, x) => { if (x === "watchdog" || x === "service") v.logSource = x; });
adminField("tokenName", (v, x) => { v.tokenName = x; v.tokenConfirm = ""; v.newToken = ""; });
adminField("tokenAction", (v, x) => { if (x === "rotate" || x === "revoke") v.tokenAction = x; });
adminField("tokenConfirm", (v, x) => { v.tokenConfirm = x; });
adminField("hostConfirm", (v, x) => { v.hostConfirm = x; });
adminField("setRoots", (v, x) => { v.settingsDraft.agentRoots = x; });
adminField("setModels", (v, x) => { v.settingsDraft.agentModels = x; });
adminField("setDsh", (v, x) => { v.settingsDraft.agentDshModels = x; });
adminField("setMcp", (v, x) => { v.settingsDraft.agentMcpUrl = x; });
adminField("watchdogConfirm", (v, x) => { v.watchdogConfirm = x; });
adminField("infraAction", (v, x) => { v.infraService = x; v.infraConfirm = ""; });
adminField("infraConfirm", (v, x) => { v.infraConfirm = x; });
adminField("settingsConfirm", (v, x) => { v.settingsConfirm = x; });
$("setInput").addEventListener("change", () => {
  const h = selectedHostState(fleet);
  if (!h) return;
  adminView(h.info.id).settingsDraft.input = ($("setInput") as HTMLInputElement).checked;
  renderAdmin(h);
});
$("hostRevoke").addEventListener("change", () => {
  const h = selectedHostState(fleet);
  if (!h) return;
  adminView(h.info.id).hostRevoke = ($("hostRevoke") as HTMLInputElement).checked;
  renderAdmin(h);
});
$("newTokenDone").addEventListener("click", () => { const h = selectedHostState(fleet); if (h) { adminView(h.info.id).newToken = ""; renderAdmin(h); } });
$("newTokenCopy").addEventListener("click", () => { void navigator.clipboard?.writeText($("newTokenText").textContent ?? ""); });
$("hostRotate").addEventListener("click", () => { const h = selectedHostState(fleet); if (h) void manageHost(h.info.id, "rotate"); });
$("hostRemove").addEventListener("click", () => { const h = selectedHostState(fleet); if (h) void manageHost(h.info.id, "remove"); });
for (const [id, run] of [["confSave", saveConf], ["restartGo", restartSession], ["logRead", readLog], ["tokenGo", changeToken], ["settingsSave", saveSettings], ["serviceGo", runService], ["watchdogGo", setWatchdog], ["infraGo", runInfra], ["moveGo", runMove]] as const) {
  $(id).addEventListener("click", () => { const h = selectedHostState(fleet); if (h) void run(h.info.id); });
}
adminField("filePath", (v, x) => { v.filePath = x; });
adminField("fileText", (v, x) => { v.fileDraft = x; });
adminField("fileConfirm", (v, x) => { v.fileConfirm = x; });
$("fileOpenBtn").addEventListener("click", () => { const h = selectedHostState(fleet); if (h) void openFile(h.info.id, adminView(h.info.id).filePath); });
$("fileUp").addEventListener("click", () => { const h = selectedHostState(fleet); const o = h && adminView(h.info.id).fileOpen; if (h && o) void openFile(h.info.id, parentIn(o.path, o.root)); });
$("fileNewBtn").addEventListener("click", () => {
  const h = selectedHostState(fleet);
  if (!h) return;
  const v = adminView(h.info.id);
  if (fileDirty(v) && v.fileLeaving !== "(new)") { v.fileLeaving = "(new)"; v.notice = `${h.info.name}: the open file has unsaved changes. Press New file again to drop them.`; renderAdmin(h); return; }
  v.fileLeaving = "";
  v.fileNew = true; v.fileDraft = ""; v.fileConfirm = ""; v.fileChangedOnHost = false;
  if (v.fileOpen?.kind === "dir") v.filePath = `${v.fileOpen.path}/`;
  renderAdmin(h);
});
$("fileSave").addEventListener("click", () => { const h = selectedHostState(fleet); if (h) void saveFile(h.info.id); });
$("fileList").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest?.("button.fileentry") as HTMLElement | null;
  const h = selectedHostState(fleet);
  if (!b || !h) return;
  const v = adminView(h.info.id);
  const target = b.dataset.root ?? (v.fileOpen?.kind === "dir" ? `${v.fileOpen.path}/${b.dataset.file}` : null);
  if (target) void openFile(h.info.id, target);
});
$("confReload").addEventListener("click", () => {
  const h = selectedHostState(fleet);
  if (!h) return;
  const v = adminView(h.info.id);
  v.notice = ""; v.saveConfirm = "";
  void refreshAdmin(h.info.id, { conf: false });
});
$("serviceAction").addEventListener("change", () => {
  const h = selectedHostState(fleet);
  if (!h) return;
  const v = adminView(h.info.id);
  v.serviceAction = ($("serviceAction") as HTMLSelectElement).value === "update" ? "update" : "restart";
  v.serviceConfirm = "";
  renderAdmin(h);
});
$("serviceTag").addEventListener("change", () => {
  const h = selectedHostState(fleet);
  if (!h) return;
  adminView(h.info.id).serviceTag = ($("serviceTag") as HTMLSelectElement).value;
  renderAdmin(h);
});
for (const [id, key] of [["moveFleet", "moveFleet"], ["moveDir", "moveDir"], ["moveSocket", "moveSocket"], ["moveConfirm", "moveConfirm"]] as const) {
  for (const ev of ["input", "change"]) $(id).addEventListener(ev, () => {
    const h = selectedHostState(fleet);
    if (!h) return;
    adminView(h.info.id)[key] = ($(id) as HTMLInputElement).value;
    renderAdmin(h);
  });
}
for (const ev of ["input", "change"]) $("serviceConfirm").addEventListener(ev, () => {
  const h = selectedHostState(fleet);
  if (!h) return;
  adminView(h.info.id).serviceConfirm = ($("serviceConfirm") as HTMLInputElement).value;
  renderAdmin(h);
});
$("settingsReload").addEventListener("click", () => {
  const h = selectedHostState(fleet);
  if (!h) return;
  const v = adminView(h.info.id);
  v.notice = ""; v.settingsConfirm = "";
  void refreshAdmin(h.info.id, { settings: false });
});
$("agentOrchestrator").addEventListener("change", () => {
  const h = selectedHostState(fleet);
  if (!h) return;
  agentView(h.info.id).form.orchestrator = ($("agentOrchestrator") as HTMLInputElement).checked;
  renderAgents(h);
});
$("agentForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const h = selectedHostState(fleet);
  if (h) void startAgent(h.info.id);
});

// The answer is bound to the host, request id and revision the clicked button was drawn from.
async function answer(hostId: string, requestId: string, response: string, expectedRevision: number) {
  const begun = beginAnswer(fleet, hostId, requestId, expectedRevision);
  if (!begun.handle) return;
  apply(begun.fleet);
  render();
  const handle = begun.handle;
  const host = fleet.hosts[hostId]!.info;
  const { outcome } = await hostCall(host, `/requests/${encodeURIComponent(requestId)}/resolve`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response, expectedRevision }),
  }, WRITE_TIMEOUT_MS);
  const notice = outcome.ok ? `${host.name}: answer "${response}" recorded for revision ${expectedRevision}. The supervisor has not acknowledged it yet.`
    : outcome.kind === "network" || outcome.kind === "invalid" || (outcome.status ?? 0) >= 500 || outcome.status === 408 ? `${host.name} did not answer clearly. Unknown whether the answer was recorded.`
    : `${host.name}: answer not recorded: ${outcome.message}`;
  if (fleet.hosts[hostId]?.gen === handle.gen) lastReviewNotice = { ...handle, text: notice };
  apply(finishAnswer(fleet, handle, notice));
  render();
  void refresh(hostId, "coord");
}

$('studioProjects').addEventListener('change', () => {
  const value = ($('studioProjects') as HTMLSelectElement).value;
  if (value && !visibleProjects.includes(value)) return;
  studioProject = value; reviewing = null; decisionQueue = 'pending'; studioView = 'dashboard';
  setNavigation(false, true); render();
});
$('studioContent').addEventListener('change', event => {
  const select = event.target as HTMLSelectElement;
  const key = select.dataset.pref as Preference;
  if (studioView !== 'settings' || !Object.hasOwn(preferenceOptions, key) || !Object.hasOwn(preferenceOptions[key], select.value)) return;
  draftPrefs[key] = select.value; preferenceStatus = 'No pending changes'; renderStudio();
});
$("fleetGroup").addEventListener("change", renderStudio);
$("fleetReadState").addEventListener("change", renderStudio);
$('projectEditor').addEventListener('submit', event => {
  event.preventDefault();
  if (!editingProject || studioView !== 'workspaces') return;
  const name = ($('projectName') as HTMLInputElement).value.trim();
  if (!name || name.length > 48 || /[<>&\x00-\x1f]/.test(name)) { $('projectError').textContent = 'Choose a name of up to 48 characters without markup or control characters.'; return; }
  if (['All projects', ...visibleProjects].some(p => p.toLowerCase() === name.toLowerCase())) { $('projectError').textContent = 'That project name already exists or is reserved.'; return; }
  localProjects.add(name); studioProject = name; studioView = 'dashboard'; render();
});
$("fleetQuery").addEventListener("input", renderStudio);
$("activityQuery").addEventListener("input", renderStudio);
$("instruction").addEventListener("input", () => {
  const h = selectedHostState(fleet);
  if (h) apply(setDraft(fleet, h.info.id, ($("instruction") as HTMLTextAreaElement).value));
  renderComposer(selectedHostState(fleet));
});

$("instructionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const h = selectedHostState(fleet);
  if (!h) return;
  const host = h.info;
  const begun = beginSend(fleet, host.id, composerTarget(h), ($("instruction") as HTMLTextAreaElement).value, () => crypto.randomUUID());
  apply(begun.fleet);
  const intent: CommandIntent | null = begun.intent;
  render();
  if (!intent) return;
  // Everything below uses the captured host and intent, never the current selection.
  const { status, outcome } = await hostCall(host, "/commands", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: intent.key, target: intent.target, text: intent.text }),
  }, WRITE_TIMEOUT_MS);
  const submitted = outcome.ok && isCommand((outcome.data as { command?: unknown }).command) ? (outcome.data as { command: Command }).command : null;
  const kind = host.supervisor && status !== null && status >= 200 && status <= 299 && (!submitted || submitted.target !== intent.target || submitted.hostId !== host.supervisor.hostId || submitted.text !== intent.text || (submitted as Command & { idempotencyKey?: unknown }).idempotencyKey !== intent.key) ? "uncertain" : classifySend(status);
  let notice: string;
  if (kind === "queued") {
    const cmd = submitted;
    notice = cmd ? `${host.name} · ${cmd.id.slice(0, 12)}: ${commandLabel[cmd.status] ?? cmd.status}.` : `${host.name}: accepted.`;
  } else if (kind === "rejected") {
    notice = `${host.name}: not queued: ${outcome.ok ? "refused" : outcome.message}`;
  } else {
    notice = `${host.name} did not answer clearly. Unknown whether the instruction to ${intent.target} was queued; sending the same text again reuses the same key.`;
  }
  apply(finishSend(fleet, intent, kind, notice, submitted ?? undefined));
  render();
  if (host.supervisor && fleet.hosts[host.id]?.gen === intent.gen) {
    void readCooperativePage(host.id, "commands");
    if (kind === "queued" && submitted) void readCooperativePage(host.id, "inspection");
  }
  else void refresh(host.id, "coord");
});

setInspector(inspectorOpen);
await init();
render();
await loadHostList();
// A hidden tab skips polling; showing it again refreshes at once instead of waiting for the next tick.
const visible = () => !document.hidden;
setInterval(() => { if (visible()) void refreshAll("coord"); }, 3000);
setInterval(() => { if (visible()) void refreshAll("sessions"); }, 15000);
// Agents are read every 15 s, or every 3 s on the selected host while one is starting or stopping.
let agentTick = 0;
setInterval(() => {
  if (!visible()) return;
  agentTick++;
  const h = selectedHostState(fleet);
  for (const id of fleet.order) if (agentTick % 5 === 0 || (h?.info.id === id && settling(agentView(id).list))) void refreshAgents(id);
}, 3000);
setInterval(() => { if (visible()) void loadHostList(); }, 60000);
// Each open pane holds a terminal socket and a PTY on the host, which count against its viewer cap.
// A tab hidden for a minute gives them back; the sessions refresh on showing rebuilds the panes.
const HIDDEN_RELEASE_MS = 60_000;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
document.addEventListener("visibilitychange", () => {
  if (!visible()) {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      stopPanes();
      renderedPanes = "";
      // Old panes would still say "live"; the sessions refresh on showing draws new ones.
      $("terminals").textContent = "Terminals paused while the tab was hidden";
    }, HIDDEN_RELEASE_MS);
    return;
  }
  clearTimeout(releaseTimer);
  void refreshAll("coord");
  void refreshAll("sessions");
});
