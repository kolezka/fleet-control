/// <reference lib="dom" />
// Live Terminal Deck: sessions from /api/sessions, read-only panes over /api/sessions/:name/terminal.
// There is deliberately no keyboard path from a pane to the session.
import { init, Terminal } from "ghostty-web";

type Model =
  | { state: "observed"; model: string; source?: string; observedAt?: string }
  | { state: "configured"; model: string; note: string }
  | { state: "unknown"; lastObserved: { model: string; observedAt: string } | null; reason?: string }
  | { state: "not_applicable" };
type Session = { name: string; host: string | null; role: string | null; registered: boolean; running: boolean; model: Model };

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const LOCAL = "This host";

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

// With auth on, a 401 means the cookie is missing or revoked: go to sign-in instead of showing stale data.
async function api(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) location.assign("/login");
  return res;
}

const state = { selected: "" as string, inspector: true, sessions: [] as Session[] };
const panes = new Map<string, { term: Terminal; ws: WebSocket }>();

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderNav(sessions: Session[]) {
  const hosts = [...new Set(sessions.map((s) => s.host ?? LOCAL))];
  $("sidebar").innerHTML =
    `<div class="sidebarhead"><span>Hosts</span><span>${hosts.length}</span></div>` +
    hosts.map((host) => {
      const list = sessions.filter((s) => (s.host ?? LOCAL) === host);
      return `<section class="hostgroup" aria-label="${esc(host)}"><button class="hostbutton" aria-pressed="true"><span class="hosticon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 20h8m-4-3v3"/></svg></span><span class="hostidentity"><strong>${esc(host)}</strong><small>${list.length} ${list.length === 1 ? "session" : "sessions"}</small></span></button>` +
        `<div class="host-sessions">${list.map((s) => `<button class="session" data-session="${esc(s.name)}" aria-pressed="${state.selected === s.name}"><span class="dot ${s.running ? "good" : ""}"></span><span><strong>${esc(s.name)}</strong><small title="${esc(modelDetail(s.model))}">${s.running ? "Running" : "Not running"} · ${esc(modelLabel(s.model))}</small></span></button>`).join("")}</div></section>`;
    }).join("") +
    `<div class="sidebarfoot"><span>Service runs on this host</span><span>This browser is a read-only client</span></div>`;
}

const SIZE_HINT = /\x1b\]777;fleet-size;(\d+);(\d+)\x07/;

// The terminal is created at the agent window size announced by agent-fleet, so it never needs a
// resize of the agent window.
function openPane(s: Session, el: HTMLElement) {
  const url = new URL(`/api/sessions/${encodeURIComponent(s.name)}/terminal?cols=80&rows=24`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const dec = new TextDecoder();
  const status = el.closest(".terminal")!.querySelector(".termstate")!;
  let term: Terminal | null = null;
  let pending = "";
  const create = (cols: number, rows: number) => {
    term = new Terminal({
      cols, rows, disableStdin: true, cursorBlink: false, fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: { background: css("--terminal"), foreground: css("--ink"), cursor: css("--muted") },
    });
    term.open(el);
    panes.set(s.name, { term, ws });
  };
  ws.onopen = () => { status.textContent = "Read-only · live"; };
  ws.onmessage = (e) => {
    let text = dec.decode(e.data as ArrayBuffer, { stream: true });
    if (!term) {
      pending += text;
      const hint = SIZE_HINT.exec(pending);
      // Without a hint (older CLI or a remote host) fall back to 80x24 once output has started.
      if (!hint && pending.length < 64) return;
      create(hint ? Number(hint[1]) : 80, hint ? Number(hint[2]) : 24);
      text = pending;
      pending = "";
    }
    text = text.replace(new RegExp(SIZE_HINT.source, "g"), "");
    // ghostty-web 0.4.0 throws "offset is out of bounds" on an empty write.
    if (text) term!.write(text);
  };
  ws.onclose = (e) => {
    status.textContent = e.code === 1000 ? "Viewer ended" : `Disconnected (${e.code}) · state unknown`;
  };
}

function renderPanes(sessions: Session[]) {
  for (const { term, ws } of panes.values()) { ws.close(); term?.dispose(); }
  panes.clear();
  const running = sessions.filter((s) => s.running);
  const box = $("terminals");
  if (running.length === 0) {
    box.innerHTML = `<div class="empty"><span>No running sessions</span><small>fleet status reports no running session on this host.</small></div>`;
    return;
  }
  box.innerHTML = running.map((s) =>
    `<article class="terminal ${state.selected === s.name ? "active" : ""}" data-pane="${esc(s.name)}"><header class="termhead"><strong><span class="dot good"></span>${esc(s.name)}</strong><small class="termstate">Connecting</small></header><div class="xterm-host"></div><footer class="termfooter"><span class="modelinfo" title="${esc(modelDetail(s.model))}">${esc(modelLabel(s.model))}</span><span>tmux via fleet attach --read-only</span></footer></article>`,
  ).join("");
  for (const s of running) openPane(s, box.querySelector(`[data-pane="${CSS.escape(s.name)}"] .xterm-host`) as HTMLElement);
}

async function load() {
  const res = await api("/api/sessions");
  const body = await res.json();
  if (!res.ok) {
    $("alert").hidden = false;
    $("alert").textContent = `Cannot read fleet status: ${body.error?.message ?? res.status}. Current execution state is unknown.`;
    $("hostSubtitle").textContent = "Fleet status unavailable";
    return;
  }
  $("alert").hidden = true;
  const sessions: Session[] = body.sessions;
  const runningKey = (list: Session[]) => list.filter((s) => s.running).map((s) => s.name).join("\n");
  const panesChanged = runningKey(sessions) !== runningKey(state.sessions) || panes.size === 0;
  state.sessions = sessions;
  state.selected ||= sessions.find((s) => s.running)?.name ?? "";
  $("hostSubtitle").textContent = `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} · read ${new Date(body.readAt).toLocaleTimeString()}`;
  renderNav(sessions);
  // Reopening viewers on every refresh would flicker; only labels change in place.
  if (panesChanged) renderPanes(sessions);
  else for (const s of sessions) {
    const info = document.querySelector(`[data-pane="${CSS.escape(s.name)}"] .modelinfo`) as HTMLElement | null;
    if (info) { info.textContent = modelLabel(s.model); info.title = modelDetail(s.model); }
  }
}

document.addEventListener("click", (e) => {
  const b = (e.target as Element).closest("button");
  if (!b) return;
  if (b.dataset.session) {
    state.selected = b.dataset.session;
    document.querySelectorAll(".session").forEach((x) => x.setAttribute("aria-pressed", String((x as HTMLElement).dataset.session === state.selected)));
    document.querySelectorAll(".terminal").forEach((x) => x.classList.toggle("active", (x as HTMLElement).dataset.pane === state.selected));
    renderComposer();
  }
  if (b.dataset.answer) answer(b.dataset.request!, b.dataset.answer, Number(b.dataset.revision), b);
  if (b.id === "inspectorToggle") {
    state.inspector = !state.inspector;
    $("app").classList.toggle("only-terminal", !state.inspector);
    b.setAttribute("aria-expanded", String(state.inspector));
    const label = state.inspector ? "Hide supervisor panel" : "Show supervisor panel";
    b.setAttribute("aria-label", label);
    b.title = label;
  }
});

// Supervisor panel: requests, phase record and commands come from this service. Every label says
// how far a step got; nothing here claims execution that the supervisor has not reported.
type Run = { id: string; orchestrator: string; phase: string; revision: number; phaseStatus: string; updatedAt: string };
type Req = {
  id: string; runId: string; phase: string; revision: number; kind: string; question: string; proposedAction: string; scope: string;
  evidence: string[]; allowedResponses: string[]; status: string; response: string | null; resolvedBy: string | null; resolutionNote: string | null;
};
type Command = { id: string; target: string; actor: string; text: string; status: string; response: string | null; updatedAt: string; createdAt: string };

const coord = { runs: [] as Run[], requests: [] as Req[], commands: [] as Command[], reachable: true, pendingKey: "" };

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

function renderRequests() {
  const box = $("requests");
  const open = coord.requests.filter((r) => r.status === "open");
  const shown = open.length ? open : coord.requests.slice(-1);
  if (!shown.length) {
    box.innerHTML = `<div class="sectionheading"><h3>Requests</h3></div><p class="phase-note">${coord.reachable ? "No supervisor request on this service." : "Service unreachable. Request state is unknown."}</p>`;
    return;
  }
  box.innerHTML = shown.map((r) => {
    const actionable = r.status === "open" && coord.reachable;
    const result = r.response ? `Answered "${esc(r.response)}" by ${esc(r.resolvedBy ?? "?")}.${r.status === "resolved" ? " The supervisor has not acknowledged it yet." : ""}` : "";
    return `<div class="sectionheading"><h3>Request</h3><span class="requeststatus">${esc(requestLabel[r.status] ?? r.status)}</span></div>` +
      `<h2 class="requesttitle">${esc(r.question)}</h2>` +
      (r.proposedAction ? `<p class="requestcopy">${esc(r.proposedAction)}</p>` : "") +
      `<p class="requestref">${esc(r.id.slice(0, 12))} · ${esc(r.phase)} · revision ${r.revision}</p>` +
      (r.evidence.length || r.scope ? `<details class="requestevidence"><summary>View evidence and scope</summary><dl>${r.evidence.map((e) => `<div><dt>Evidence</dt><dd>${esc(e)}</dd></div>`).join("")}</dl>${r.scope ? `<p class="fineprint">${esc(r.scope)}</p>` : ""}</details>` : "") +
      (actionable ? `<div class="requestactions">${r.allowedResponses.map((a) => `<button type="button" data-request="${esc(r.id)}" data-answer="${esc(a)}" data-revision="${r.revision}">${esc(verb(a))}</button>`).join("")}</div>` : "") +
      `<p class="requestresult" aria-live="polite">${result}</p>`;
  }).join("");
}

function renderWorkflow() {
  const run = coord.runs.at(-1);
  $("coordContext").textContent = run ? `${run.id} · ${run.orchestrator}` : coord.reachable ? "No run registered" : "Service unreachable";
  $("runName").textContent = run?.id ?? "";
  if (!run) {
    $("phaseState").textContent = coord.reachable ? "No run registered on this service." : "Workflow state unknown.";
    $("workflowSteps").innerHTML = "";
    return;
  }
  const reqs = coord.requests.filter((r) => r.runId === run.id && r.phase === run.phase && r.revision === run.revision && r.kind === "approval");
  const decision = reqs.find((r) => r.response === "decline") ? "Declined" : reqs.find((r) => r.response === "approve") ? "Approved" : reqs.some((r) => r.status === "open") ? "Pending" : "Not requested";
  $("phaseState").textContent = `${run.phase} · revision ${run.revision} · ${run.phaseStatus}`;
  const rows: [string, string, string, string][] = [
    ["1", run.phase, run.phaseStatus, ""],
    ["·", "Human decision", decision, decision === "Approved" ? "done" : "wait"],
  ];
  $("workflowSteps").innerHTML = rows.map(([mark, title, status, kind]) => `<li><span class="stepmark ${kind}">${esc(mark)}</span><span>${esc(title)}</span><small>${esc(status)}</small></li>`).join("");
}

function renderExchange() {
  $("exchangeRows").innerHTML = coord.commands.slice(-6).map((c) =>
    `<li><div class="exchangemeta"><strong>${esc(c.actor)} → ${esc(c.target)}</strong><time>${esc(time(c.updatedAt))}</time></div><p>${esc(c.text)}</p>` +
    (c.response ? `<p>${esc(c.response)}</p>` : "") +
    `<span class="receipt">${esc(c.id.slice(0, 12))} · ${esc(commandLabel[c.status] ?? c.status)}</span></li>`,
  ).join("");
  $("eventText").textContent = coord.commands.length ? "" : "No commands yet.";
}

// The instruction goes to the run's orchestrator session when one is registered, otherwise to the
// selected session. The target is always shown before sending.
function composerTarget(): string {
  const orch = coord.runs.at(-1)?.orchestrator;
  if (orch && state.sessions.some((s) => s.name === orch && s.running)) return orch;
  return state.sessions.find((s) => s.name === state.selected && s.running)?.name ?? "";
}

function renderComposer() {
  const target = composerTarget();
  $("composerTarget").textContent = target ? `To ${target} · fleet send` : "No running session selected";
  ($("sendInstruction") as HTMLButtonElement).disabled = !coord.reachable || !target || !($("instruction") as HTMLTextAreaElement).value.trim();
}

async function poll() {
  try {
    const [rq, cm] = await Promise.all([api("/api/requests"), api("/api/commands")]);
    if (rq.ok) Object.assign(coord, await rq.json());
    if (cm.ok) coord.commands = ((await cm.json()) as { commands: Command[] }).commands;
    coord.reachable = true;
  } catch {
    coord.reachable = false;
  }
  renderRequests();
  renderWorkflow();
  renderExchange();
  renderComposer();
  $("status").textContent = coord.reachable ? "Read-only terminals · supervisor panel live" : "Service unreachable · state unknown";
}

async function answer(requestId: string, response: string, expectedRevision: number, button: HTMLButtonElement) {
  button.disabled = true;
  try {
    const res = await api(`/api/requests/${encodeURIComponent(requestId)}/resolve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response, expectedRevision }),
    });
    const body = await res.json();
    if (!res.ok) $("instructionStatus").textContent = `Answer not recorded: ${body.error?.message ?? res.status}`;
    else $("instructionStatus").textContent = `Answer "${response}" recorded for revision ${expectedRevision}. The supervisor has not acknowledged it yet.`;
  } catch {
    $("instructionStatus").textContent = "Service unreachable. The answer was not recorded.";
  }
  await poll();
}

$("instruction").addEventListener("input", renderComposer);
$("instructionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const box = $("instruction") as HTMLTextAreaElement;
  const text = box.value.trim();
  const target = composerTarget();
  if (!text || !target) return;
  // Reuse the key until the service answers, so a retry after a network error cannot queue twice.
  coord.pendingKey ||= crypto.randomUUID();
  ($("sendInstruction") as HTMLButtonElement).disabled = true;
  try {
    const res = await api("/api/commands", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: coord.pendingKey, target, text }),
    });
    const body = await res.json();
    if (!res.ok) {
      $("instructionStatus").textContent = `Not queued: ${body.error?.message ?? res.status}`;
    } else {
      coord.pendingKey = "";
      box.value = "";
      $("instructionStatus").textContent = `${body.command.id.slice(0, 12)}: ${commandLabel[body.command.status] ?? body.command.status}.`;
    }
  } catch {
    $("instructionStatus").textContent = "Service unreachable. Unknown whether the instruction was queued; sending again reuses the same key.";
  }
  await poll();
});

await init();
await load();
await poll();
setInterval(poll, 3000);
setInterval(() => load().catch(() => {}), 15000);
