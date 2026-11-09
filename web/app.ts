/// <reference lib="dom" />
// Live Terminal Deck: sessions from /api/sessions, read-only panes over /api/sessions/:name/terminal.
// There is deliberately no keyboard path from a pane to the session.
import { init, Terminal } from "ghostty-web";

type Model =
  | { state: "observed"; model: string; observedAt?: string }
  | { state: "configured"; model: string; note: string }
  | { state: "unknown"; lastObserved: { model: string; observedAt: string } | null }
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

const state = { selected: "" as string, inspector: true };
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
        `<div class="host-sessions">${list.map((s) => `<button class="session" data-session="${esc(s.name)}" aria-pressed="${state.selected === s.name}"><span class="dot ${s.running ? "good" : ""}"></span><span><strong>${esc(s.name)}</strong><small>${s.running ? "Running" : "Not running"} · ${esc(modelLabel(s.model))}</small></span></button>`).join("")}</div></section>`;
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
    `<article class="terminal ${state.selected === s.name ? "active" : ""}" data-pane="${esc(s.name)}"><header class="termhead"><strong><span class="dot good"></span>${esc(s.name)}</strong><small class="termstate">Connecting</small></header><div class="xterm-host"></div><footer class="termfooter"><span>${esc(modelLabel(s.model))}</span><span>tmux via fleet attach --read-only</span></footer></article>`,
  ).join("");
  for (const s of running) openPane(s, box.querySelector(`[data-pane="${CSS.escape(s.name)}"] .xterm-host`) as HTMLElement);
}

async function load() {
  const res = await fetch("/api/sessions");
  const body = await res.json();
  if (!res.ok) {
    $("alert").hidden = false;
    $("alert").textContent = `Cannot read fleet status: ${body.error?.message ?? res.status}. Current execution state is unknown.`;
    $("hostSubtitle").textContent = "Fleet status unavailable";
    return;
  }
  const sessions: Session[] = body.sessions;
  state.selected ||= sessions.find((s) => s.running)?.name ?? "";
  $("hostSubtitle").textContent = `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} · read ${new Date(body.readAt).toLocaleTimeString()}`;
  renderNav(sessions);
  renderPanes(sessions);
}

document.addEventListener("click", (e) => {
  const b = (e.target as Element).closest("button");
  if (!b) return;
  if (b.dataset.session) {
    state.selected = b.dataset.session;
    document.querySelectorAll(".session").forEach((x) => x.setAttribute("aria-pressed", String((x as HTMLElement).dataset.session === state.selected)));
    document.querySelectorAll(".terminal").forEach((x) => x.classList.toggle("active", (x as HTMLElement).dataset.pane === state.selected));
  }
  if (b.id === "inspectorToggle") {
    state.inspector = !state.inspector;
    $("app").classList.toggle("only-terminal", !state.inspector);
    b.setAttribute("aria-expanded", String(state.inspector));
    const label = state.inspector ? "Hide supervisor panel" : "Show supervisor panel";
    b.setAttribute("aria-label", label);
    b.title = label;
  }
});

await init();
await load();
