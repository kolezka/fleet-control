/// <reference lib="dom" />
// Live Terminal Deck: hosts with nested sessions on the left, the selected host's read-only panes in the
// centre, the selected host's supervisor panel on the right. Every host is read and written through its
// own base path (`/api` for a single host service, `/api/hosts/<id>` through a gateway) and has its own
// state in web/host-state.ts. There is deliberately no keyboard path from a pane to the session.
import { init, Terminal } from "ghostty-web";
import {
  type Command, type CommandIntent, type Fleet, type HostInfo, type HostState, type Model, type Outcome, type Peer, type ReadKind, type Req, type Session,
  answerKey, beginAnswer, beginRead, beginSend, classifySend, composerTarget, describeSessions, emptyFleet, finishAnswer, finishRead, finishSend,
  interpretResponse, paneKey, parseCoord, parseHostList, parseSessions, selectHost, selectSession, selectedHostState, sendGate, setDraft, setHosts,
} from "./host-state.ts";

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

// One call to one host. A 401 from a single host service means this page has no sign-in: go to /login.
// Through a gateway a 401 is that upstream host's answer, so it only makes that host unknown.
async function hostCall(host: HostInfo, path: string, init: RequestInit = {}, timeoutMs = READ_TIMEOUT_MS): Promise<{ status: number | null; outcome: Outcome<unknown> }> {
  try {
    const res = await fetch(`${host.apiBase}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 && host.direct) location.assign("/login");
    const body = await res.json().catch(() => null);
    return { status: res.status, outcome: interpretResponse(res.status, body) };
  } catch (e) {
    return { status: null, outcome: { ok: false, kind: "network", message: e instanceof Error && e.name === "TimeoutError" ? "No answer in time" : "Unreachable" } };
  }
}

let fleet: Fleet = emptyFleet();
let mode: "gateway" | "direct" | "" = "";
let peers: Peer[] = [];
let hostListError = "";
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
    ? `<span>Each host keeps its own state</span><span>This browser is a read-only client</span>`
    : `<span>Service runs on this host</span><span>This browser is a read-only client</span>`;
  setHtml($("sidebar"), `<div class="sidebarhead"><span>Hosts</span><span>${fleet.order.length + peers.length}</span></div>${groups}${peerLinks}<div class="sidebarfoot">${foot}</div>`);
}

const SIZE_HINT = /\x1b\]777;fleet-size;(\d+);(\d+)\x07/;

// The terminal is created at the agent window size announced by agent-fleet, so it never needs a
// resize of the agent window. After an unexpected close the pane reconnects with backoff; a new
// tmux attach redraws the whole screen, so the old terminal is replaced, not appended to.
type Pane = { stop(): void };
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];


function openPane(s: Session, el: HTMLElement, apiBase: string): Pane {
  const status = el.closest(".terminal")!.querySelector(".termstate")!;
  let term: Terminal | null = null;
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const url = new URL(`${apiBase}/sessions/${encodeURIComponent(s.name)}/terminal?cols=80&rows=24`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(url);
    ws = sock;
    sock.binaryType = "arraybuffer";
    const dec = new TextDecoder();
    let pending = "";
    let fresh = true;
    sock.onopen = () => { status.textContent = "Read-only · live"; };
    sock.onmessage = (e) => {
      let text = dec.decode(e.data as ArrayBuffer, { stream: true });
      if (fresh) {
        pending += text;
        const hint = SIZE_HINT.exec(pending);
        // Without a hint (older CLI or a remote host) fall back to 80x24 once output has started.
        if (!hint && pending.length < 64) return;
        term?.dispose();
        el.replaceChildren();
        term = new Terminal({
          cols: hint ? Number(hint[1]) : 80, rows: hint ? Number(hint[2]) : 24, disableStdin: true, cursorBlink: false, fontSize: 12,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          theme: { background: css("--terminal"), foreground: css("--ink"), cursor: css("--muted") },
        });
        term.open(el);
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
      // 1000: the viewer ended normally (session gone). 1008: the server refused us. Neither is retried.
      if (e.code === 1000 || e.code === 1008) {
        status.textContent = e.code === 1000 ? "Viewer ended" : `Refused (${e.code})`;
        return;
      }
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
      attempt++;
      status.textContent = `Disconnected (${e.code}) · state unknown · retry in ${Math.round(wait / 1000)} s`;
      timer = setTimeout(connect, wait);
    };
  };
  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
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
      box.innerHTML = `<div class="empty"><span>${hostListError ? "No host list" : "Loading hosts"}</span></div>`;
    } else if (running.length === 0) {
      const r = h.sessionsRead;
      box.innerHTML = r.status === "loading"
        ? `<div class="empty"><span>Reading sessions on ${esc(h.info.name)}</span></div>`
        : r.status === "unknown"
          ? `<div class="empty"><span>State unknown on ${esc(h.info.name)}</span><small>${esc(r.error ?? "The host could not be read")}. This does not mean it has no sessions or that they stopped.</small></div>`
          : `<div class="empty"><span>No running sessions</span><small>fleet status reports no running session on ${esc(h.info.name)}.</small></div>`;
    } else {
      box.innerHTML = running.map((s) =>
        `<article class="terminal" data-pane="${esc(s.name)}"><header class="termhead"><strong><span class="dot good"></span>${esc(s.name)}</strong><small class="termstate">Connecting</small></header><div class="xterm-host"></div><footer class="termfooter"><span class="modelinfo"></span><span>tmux via fleet attach --read-only</span></footer></article>`,
      ).join("");
      for (const s of running) panes.set(s.name, openPane(s, box.querySelector(`[data-pane="${CSS.escape(s.name)}"] .xterm-host`) as HTMLElement, h.info.apiBase));
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
  const known = h?.coordRead.status === "ready";
  const run = known ? h!.coord.runs.at(-1) : undefined;
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
  const cmds: Command[] = h ? h.coord.commands.slice(-6) : [];
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
    ? `To ${target} on ${h.info.name} · fleet send`
    : gate.reason === "no-target" ? `No running session selected on ${h.info.name}`
    : gate.reason === "sending" ? `Sending to ${h.intent?.target ?? target} on ${h.info.name}`
    : `${h.info.name}: ${SEND_REASON[gate.reason]}`;
  $("instructionStatus").textContent = h.notice;
  send.disabled = !gate.ok;
}

function renderChrome(h: HostState | undefined) {
  $("hostTitle").textContent = h ? h.info.name : "Fleet Control";
  const v = h ? describeSessions(h) : null;
  $("hostSubtitle").textContent = !h || !v ? (hostListError || "Loading hosts")
    : v.kind === "loading" ? "Reading sessions"
    : v.kind === "ready" ? `${plural(v.count)} · read ${clock(v.at)}`
    : `State unknown${v.lastKnownCount !== null ? ` · last read ${clock(v.at)}` : ""}`;
  const alert = $("alert");
  const msgs: string[] = [];
  if (hostListError) msgs.push(hostListError);
  if (h?.sessionsRead.status === "unknown") msgs.push(`Cannot read ${h.info.name}: ${h.sessionsRead.error ?? "unreachable"}. Its execution state is unknown, not stopped. Other hosts are unaffected.`);
  else if (h?.coordRead.status === "unknown") msgs.push(`Cannot read supervisor state on ${h.info.name}: ${h.coordRead.error ?? "unreachable"}. Request state is unknown.`);
  alert.hidden = msgs.length === 0;
  alert.textContent = msgs.join(" ");
  $("status").textContent = !h ? "Read-only terminals" : h.coordRead.status === "ready" ? `${h.info.name} · read-only terminals · supervisor panel live` : `${h.info.name} · state unknown or loading`;
}

function render() {
  const h = selectedHostState(fleet);
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
  const begun = beginRead(fleet, hostId, kind);
  if (!begun.token) return;
  apply(begun.fleet);
  const host = fleet.hosts[hostId]!.info;
  let result: Outcome<any>;
  if (kind === "sessions") {
    const { outcome } = await hostCall(host, "/sessions");
    result = outcome.ok ? parseSessions(outcome.data) : outcome;
  } else {
    const [rq, cm] = await Promise.all([hostCall(host, "/requests"), hostCall(host, "/commands")]);
    result = parseCoord(rq.outcome, cm.outcome);
  }
  apply(finishRead(fleet, hostId, kind, begun.token, result, new Date().toISOString()));
  render();
}
const refreshAll = (kind: ReadKind) => Promise.all(fleet.order.map((id) => refresh(id, kind)));

let hostListBusy = false;
async function loadHostList() {
  if (hostListBusy) return;
  hostListBusy = true;
  try {
    const res = await fetch("/api/hosts", { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (res.status === 401) { location.assign("/login"); return; }
    const list = res.ok ? parseHostList(await res.json().catch(() => null)) : null;
    if (!list) { hostListError = `Cannot read the host list (${res.status}). Host state is unknown.`; render(); return; }
    hostListError = list.hosts.length ? "" : "The gateway lists no hosts.";
    mode = list.mode;
    peers = list.peers;
    apply(setHosts(fleet, list.hosts));
    render();
    // Hosts are read concurrently; a failing host does not delay the others.
    void refreshAll("sessions");
    void refreshAll("coord");
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
  if (b.dataset.answer) { void answer(b.dataset.host!, b.dataset.request!, b.dataset.answer, Number(b.dataset.revision)); return; }
  if (b.id === "inspectorToggle") { setInspector(!inspectorOpen); return; }
  if (b.dataset.host && b.dataset.session) {
    apply(selectSession(fleet, b.dataset.host, b.dataset.session));
    render();
  } else if (b.dataset.host) {
    apply(selectHost(fleet, b.dataset.host));
    render();
    // The host may have been off screen for a while; read it again now.
    void refresh(b.dataset.host, "sessions");
    void refresh(b.dataset.host, "coord");
  }
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
  const kind = classifySend(status);
  let notice: string;
  if (kind === "queued") {
    const cmd = outcome.ok ? (outcome.data as { command?: Command }).command : undefined;
    notice = cmd ? `${host.name} · ${cmd.id.slice(0, 12)}: ${commandLabel[cmd.status] ?? cmd.status}.` : `${host.name}: accepted.`;
  } else if (kind === "rejected") {
    notice = `${host.name}: not queued: ${outcome.ok ? "refused" : outcome.message}`;
  } else {
    notice = `${host.name} did not answer clearly. Unknown whether the instruction to ${intent.target} was queued; sending the same text again reuses the same key.`;
  }
  apply(finishSend(fleet, intent, kind, notice));
  render();
  void refresh(host.id, "coord");
});

await init();
setInspector(!overlayQuery.matches);
render();
await loadHostList();
setInterval(() => void refreshAll("coord"), 3000);
setInterval(() => void refreshAll("sessions"), 15000);
setInterval(() => void loadHostList(), 60000);
