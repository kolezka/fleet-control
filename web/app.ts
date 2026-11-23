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
import { type AdminView, changeable, emptyAdmin, hostGate, parseConf, parseTokens, restartable, restartGate, saveGate, tokenGate } from "./fleet-admin.ts";
import { type AgentForm, type AgentKind, type AgentList, KIND_LABEL, agentStateText, canStop, kindsOf, modelsFor, parseAgents, settling, startGate } from "./agents.ts";

const $ = (id: string) => document.getElementById(id)!;
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
let inspectorOpen = true;
const apply = (f: Fleet) => { fleet = f; };

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

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

function renderNav() {
  const groups = fleet.order.map((id) => {
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
    return `<section class="hostgroup" aria-label="${esc(h.info.name)}"><button type="button" class="hostbutton" data-fk="h:${esc(id)}" data-host="${esc(id)}" aria-pressed="${here}">${HOST_ICON}<span class="hostidentity"><strong>${esc(h.info.name)}</strong><small>${esc(hostSubtitle(h))}</small></span></button><div class="host-sessions">${rows}</div></section>`;
  }).join("");
  // A single host service only links to other hosts' own services; it never reads their sessions.
  const peerLinks = peers.map((p) => `<section class="hostgroup peer" aria-label="${esc(p.name)}"><a class="hostbutton" href="${esc(p.url)}" target="_blank" rel="noopener">${HOST_ICON}<span class="hostidentity"><strong>${esc(p.name)}</strong><small>Own service · open</small></span></a></section>`).join("");
  const foot = mode === "gateway"
    ? `${enroll ? '<a class="footlink" href="./add-host">Add a host</a>' : ""}${installer ? '<a class="footlink" href="./install">Install on this machine</a>' : ""}<span>Each host keeps its own state</span><span>This browser is a read-only client</span>`
    : `<span>Service runs on this host</span><span>This browser is a read-only client</span>`;
  setHtml($("sidebar"), `<div class="sidebarhead"><span>Hosts</span><span>${fleet.order.length + peers.length}</span></div>${groups}${peerLinks}<div class="sidebarfoot">${foot}</div>`);
}

const SIZE_HINT = /\x1b\]777;fleet-size;(\d+);(\d+)\x07/;

// The terminal is created at the agent window size announced by agent-fleet, so it never needs a
// resize of the agent window. After an unexpected close the pane reconnects with backoff; a new
// tmux attach redraws the whole screen, so the old terminal is replaced, not appended to.
type Pane = { stop(): void };
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
          cols: hint ? Number(hint[1]) : 80, rows: hint ? Number(hint[2]) : 24, disableStdin: !mayType(lease), cursorBlink: false, fontSize: 12,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          theme: { background: css("--terminal"), foreground: css("--ink"), cursor: css("--muted") },
        });
        term.open(el);
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
      box.innerHTML = running.map((s) =>
        `<article class="terminal" data-pane="${esc(s.name)}"><header class="termhead"><strong><span class="dot good"></span>${esc(s.name)}</strong><small class="termstate">Connecting</small></header><div class="xterm-host"></div><footer class="termfooter"><span class="modelinfo"></span><button type="button" class="typebtn" hidden></button></footer></article>`,
      ).join("");
      for (const s of running) panes.set(s.name, openPane(s, box.querySelector(`[data-pane="${CSS.escape(s.name)}"] .xterm-host`) as HTMLElement, h.info));
    }
  }
  // Labels and emphasis change in place, so refreshes never reopen a viewer.
  if (!h) return;
  const unknown = h.sessionsRead.status === "unknown";
  for (const s of running) {
    const art = box.querySelector(`[data-pane="${CSS.escape(s.name)}"]`);
    if (!art) continue;
    art.classList.toggle("active", s.name === h.selectedSession);
    const info = art.querySelector(".modelinfo") as HTMLElement;
    const text = unknown ? "State unknown, host not readable" : modelLabel(s.model);
    if (info.textContent !== text) { info.textContent = text; info.title = unknown ? "The host could not be read" : modelDetail(s.model); }
  }
}

// As in the baseline: below 901px the supervisor panel is an overlay, so it starts closed.
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

function renderRequests(h: HostState | undefined) {
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
    const busy = h.answering.includes(answerKey(q.id, q.revision));
    const actionable = q.status === "open";
    const result = q.response ? `Answered "${esc(q.response)}" by ${esc(q.resolvedBy ?? "?")}.${q.status === "resolved" ? " The supervisor has not acknowledged it yet." : ""}` : "";
    return `<div class="sectionheading"><h3>Request</h3><span class="requeststatus">${esc(requestLabel[q.status] ?? q.status)}</span></div>` +
      `<h2 class="requesttitle">${esc(q.question)}</h2>` +
      (q.proposedAction ? `<p class="requestcopy">${esc(q.proposedAction)}</p>` : "") +
      `<p class="requestref">${esc(q.id.slice(0, 12))} · ${esc(q.phase)} · revision ${q.revision}</p>` +
      (q.evidence.length || q.scope ? `<details class="requestevidence"><summary>View evidence and scope</summary><dl>${q.evidence.map((e) => `<div><dt>Evidence</dt><dd>${esc(e)}</dd></div>`).join("")}</dl>${q.scope ? `<p class="fineprint">${esc(q.scope)}</p>` : ""}</details>` : "") +
      (actionable ? `<div class="requestactions">${q.allowedResponses.map((a) => `<button type="button" data-fk="a:${esc(q.id)}:${esc(a)}" data-host="${esc(h.info.id)}" data-request="${esc(q.id)}" data-answer="${esc(a)}" data-revision="${q.revision}"${busy ? " disabled" : ""}>${esc(verb(a))}</button>`).join("")}</div>` : "") +
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

function renderChrome(h: HostState | undefined) {
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
  if (!v) { v = { list: null, status: "loading", error: "", busy: false, notice: "", form: { name: "", kind: "claude", cwd: "", model: "", prompt: "", confirm: "", orchestrator: false } }; agentViews.set(hostId, v); }
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
  const sessions = restartable(v.conf);
  if (!sessions.includes(v.restartSession)) v.restartSession = sessions[0] ?? "";
  setHtml($("restartSession"), sessions.map(s => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('') || '<option value="">No sessions</option>');
  ($("restartSession") as HTMLSelectElement).value = v.restartSession;
  const rc = $("restartConfirm") as HTMLInputElement;
  if (rc.value !== v.restartConfirm) rc.value = v.restartConfirm;
  const restart = restartGate(v);
  $("restartGate").textContent = restart.reason;
  ($("restartGo") as HTMLButtonElement).disabled = !restart.ok;
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
  const hc = $("hostConfirm") as HTMLInputElement;
  if (hc.value !== v.hostConfirm) hc.value = v.hostConfirm;
  ($("hostRevoke") as HTMLInputElement).checked = v.hostRevoke;
  const hg = hostGate(v, h.info.id);
  $("hostGate").textContent = hg.reason;
  ($("hostRotate") as HTMLButtonElement).disabled = !hg.ok;
  ($("hostRemove") as HTMLButtonElement).disabled = !hg.ok;
  $("adminStatus").textContent = v.status === "unknown" ? `Fleet settings unknown: ${v.error}` : v.conf?.loadError ? `fleet.conf does not load: ${v.conf.loadError}` : v.notice;
}

async function refreshAdmin(hostId: string, keepDraft = true) {
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
  // Tokens: hidden where the host does not offer them (older releases, no fleet administration).
  if (v.status === "ready") {
    const t = await hostCall(host, "/tokens");
    v.tokens = t.outcome.ok ? parseTokens(t.outcome.data) : null;
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
    await refreshAdmin(hostId, false);
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
    hostListError = list.hosts.length ? "" : enroll ? "No hosts yet. Use Add a host at the bottom of the host list." : "The gateway lists no hosts.";
    peers = list.peers;
    apply(setHosts(fleet, list.hosts));
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

document.addEventListener("click", (e) => {
  const b = (e.target as Element).closest("button");
  if (!b) return;
  if (b.dataset.page) {
    const hostId = b.dataset.host!;
    if (b.dataset.page === "select") { apply(selectCommand(fleet, hostId, b.dataset.command!)); void readCooperativePage(hostId, "inspection"); }
    else void readCooperativePage(hostId, b.dataset.page === "inspect" || b.dataset.page === "events" ? "inspection" : "commands", b.dataset.page === "events" || b.dataset.page === "commands");
    return;
  }
  if (b.dataset.stop) { void stopAgent(b.dataset.host!, b.dataset.stop); return; }
  if (b.dataset.answer) { void answer(b.dataset.host!, b.dataset.request!, b.dataset.answer, Number(b.dataset.revision)); return; }
  if (b.id === "inspectorToggle") { setInspector(!inspectorOpen); return; }
  if (b.dataset.host && b.dataset.session) {
    apply(selectSession(fleet, b.dataset.host, b.dataset.session));
    render();
  } else if (b.dataset.host) {
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
adminField("logSource", (v, x) => { if (x === "watchdog" || x === "service") v.logSource = x; });
adminField("tokenName", (v, x) => { v.tokenName = x; v.tokenConfirm = ""; v.newToken = ""; });
adminField("tokenAction", (v, x) => { if (x === "rotate" || x === "revoke") v.tokenAction = x; });
adminField("tokenConfirm", (v, x) => { v.tokenConfirm = x; });
adminField("hostConfirm", (v, x) => { v.hostConfirm = x; });
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
for (const [id, run] of [["confSave", saveConf], ["restartGo", restartSession], ["logRead", readLog], ["tokenGo", changeToken]] as const) {
  $(id).addEventListener("click", () => { const h = selectedHostState(fleet); if (h) void run(h.info.id); });
}
$("confReload").addEventListener("click", () => {
  const h = selectedHostState(fleet);
  if (!h) return;
  const v = adminView(h.info.id);
  v.notice = ""; v.saveConfirm = "";
  void refreshAdmin(h.info.id, false);
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
  apply(finishAnswer(fleet, handle, notice));
  render();
  void refresh(hostId, "coord");
}

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

await init();
setInspector(!overlayQuery.matches);
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
