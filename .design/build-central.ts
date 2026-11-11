// Builds the central-server drafts from the selected Terminal Deck v4 styles.
// One shell, three screens: the deck with all hosts, adding a host, and server sign-in.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL(".", import.meta.url).pathname;
const v4 = readFileSync(`${root}drafts/console/terminal-deck/v4.html`, "utf8");
const baseCss = v4.slice(v4.indexOf("<style>") + 7, v4.indexOf("</style>"));

const extraCss = `
/* Central server additions. Tokens and rhythm come from design-system.md. */
.serverstate{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--muted);margin-right:6px;white-space:nowrap}
.serverstate strong{font-weight:500;color:var(--ink)}
.hostbutton{position:relative}
.hostmeta{display:flex;align-items:center;gap:5px}
.hostmeta .dot{width:6px;height:6px}
.hostgroup.offline .hostidentity strong{color:var(--muted)}
.hostgroup.offline .session strong{color:var(--muted)}
.hostgroup.pending .hosticon{border-style:dashed}
.addhost{display:flex;align-items:center;gap:8px;width:100%;padding:8px 6px;font-size:12px;color:var(--muted);text-align:left}
.addhost svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}
.addhost[aria-expanded="true"]{background:var(--selected);color:var(--ink)}
.queue{display:grid;gap:0}
.queuehead{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px}
.queuehead h3{font-size:11px;font-weight:500;color:var(--muted)}
.queuehead small{font-size:10px}
.queueitem{border-top:1px solid var(--line);padding:12px 0}
.queueitem:first-of-type{border-top:0;padding-top:4px}
.hosttag{display:inline-flex;align-items:center;gap:5px;font:10px var(--mono);color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:1px 6px}
.queueline{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.queueitem .requesttitle{font-size:13px;margin-bottom:4px}
.queueitem.compact .requesttitle{font-size:12px;font-weight:500;margin:0}
.queueitem.compact .requestref{margin-top:4px}
.queueitem.compact .requestactions{margin-top:9px}
.queueitem .requestactions .primary{background:var(--ink);color:var(--surface);flex:1}
.queueitem.unknown .requeststatus{color:var(--muted)}
.hostscope{font-size:10px;color:var(--muted);margin-top:2px}
.termhead .model{font:10px var(--mono);color:var(--muted)}
/* Add host sheet: anchored to the sidebar, the deck stays visible behind it. */
.sheetwrap{position:fixed;inset:46px 0 24px 220px;display:flex;align-items:flex-start;justify-content:flex-start;padding:16px;background:color-mix(in srgb,var(--bg) 55%,transparent);z-index:5}
.sheet{width:min(460px,100%);background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:20px;display:grid;gap:16px}
.sheet header{display:flex;justify-content:space-between;align-items:baseline}
.sheet h2{font-size:14px}
.sheet p{font-size:12px;color:var(--muted);line-height:1.6}
.field{display:grid;gap:6px}
.field label{font-size:12px;font-weight:500}
.field input{padding:8px 10px;background:var(--terminal);color:var(--ink);border:1px solid var(--line);border-radius:4px;font:13px var(--mono)}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:14px;counter-reset:s}
.steps li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:10px;font-size:12px;counter-increment:s}
.steps li::before{content:counter(s);width:19px;height:19px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;font-size:10px;color:var(--muted)}
.steps li.done::before{content:"✓";color:var(--good);border-color:var(--good)}
.steps li.wait::before{color:var(--warn);border-color:var(--warn)}
.steps small{display:block;font-size:11px;margin-top:3px;line-height:1.55}
.cmd{display:flex;align-items:flex-start;gap:8px;margin-top:8px;padding:9px 10px;background:var(--terminal);border:1px solid var(--line);border-radius:4px}
.cmd code{flex:1;font-size:11px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
.cmd button{font-size:11px;border-color:var(--line);padding:3px 9px;flex-shrink:0}
.sheetactions{display:flex;justify-content:space-between;align-items:center;gap:8px;border-top:1px solid var(--line);padding-top:14px}
.sheetactions small{font-size:11px}
.sheetactions button{font-size:11px;border-color:var(--line);padding:6px 12px}
.signin{min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg)}
.signincard{width:min(380px,100%);display:grid;gap:10px;padding:24px;background:var(--surface);border:1px solid var(--line);border-radius:6px}
.signincard h1{font-size:15px;margin:0 0 4px}
.signincard p{font-size:12px;color:var(--muted);line-height:1.55}
.signincard label{font-size:12px;font-weight:500;margin-top:6px}
.signincard input{padding:9px 10px;background:var(--terminal);color:var(--ink);border:1px solid var(--line);border-radius:4px;font:13px var(--mono)}
.signincard .go{margin-top:6px;padding:8px 12px;font-size:12px;background:var(--ink);color:var(--surface);border:1px solid var(--ink)}
.signincard .server{font:11px var(--mono);color:var(--muted);border-top:1px solid var(--line);padding-top:12px;margin-top:6px;display:flex;justify-content:space-between;gap:8px}
.signinerror{color:var(--bad)!important}
@media(max-width:900px){.sheetwrap{inset:46px 0 24px 0}}
@media(max-width:900px){.coordination:not(.mobile-open){display:none}.coordination.mobile-open{display:grid}}
@media(max-width:600px){.serverstate span{display:none}.sheetwrap{position:fixed;inset:46px 0 0 0;padding:10px;overflow:auto}.sheet{max-height:100%;overflow:auto}}
`;

const ICON_HOST = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 20h8m-4-3v3"/></svg>`;
const ICON_PLUS = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
const ICON_PANEL = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16m3-12v8"/></svg>`;
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

type Session = { name: string; status: string; dot: string; model: string; lines: [string, string][] };
type Host = { id: string; kind: string; state: "connected" | "offline" | "pending"; meta: string; sessions: Session[] };

const HOSTS: Host[] = [
  {
    id: "mac-mini", kind: "Mac mini", state: "connected", meta: "Connected · agent 0.5.0",
    sessions: [
      { name: "supervisor", status: "Running · Model claude-opus-4", dot: "good", model: "claude-opus-4", lines: [["accent", "> task: build the control API"], ["faint", "  run demo-42 / phase 2 / revision 7"], ["", ""], ["", "Worker report received."], ["", "Re-running the acceptance checks on the same revision."], ["good", "  PASS  command identifiers are idempotent"], ["good", "  PASS  stale phase approvals are rejected"], ["faint", "  exit code: 0"], ["", ""], ["good", "Independent review accepted."], ["warn", "Waiting for a human decision on phase 3."]] },
      { name: "worker-api", status: "Running · Model claude-sonnet-4", dot: "good", model: "claude-sonnet-4", lines: [["accent", "> phase 2: command acknowledgements"], ["faint", "  worktree: worktrees/control-api"], ["", ""], ["", "Added acknowledgement records and retry identity."], ["faint", "$ bun test tests/commands.test.ts"], ["good", "  PASS  duplicate request returns the same command"], ["good", "  PASS  stale revision rejects approval"], ["faint", "  exit code: 0"], ["", ""], ["warn", "Phase report sent. Waiting for orchestrator."]] },
      { name: "watchdog", status: "Running · No model (script)", dot: "good", model: "no model", lines: [["accent", "> session lifecycle observer"], ["", ""], ["faint", "09:40:01  supervisor   waiting"], ["faint", "09:40:01  worker-api   waiting"], ["", ""], ["", "No session replacement requested."], ["warn", "Health is not acceptance."]] },
    ],
  },
  {
    id: "rtx-desktop", kind: "Desktop", state: "offline", meta: "Disconnected 4 min ago",
    sessions: [
      { name: "trainer", status: "Unknown · last known running", dot: "", model: "", lines: [] },
      { name: "eval-runner", status: "Unknown · last known running", dot: "", model: "", lines: [] },
    ],
  },
  {
    id: "build-box", kind: "Server", state: "connected", meta: "Connected · agent 0.5.0",
    sessions: [
      { name: "release-worker", status: "Not running", dot: "", model: "", lines: [] },
    ],
  },
];

function sidebar(selected: string, opts: { pending?: string; addOpen?: boolean } = {}) {
  const hosts = HOSTS.map((h) => {
    const sessions = h.sessions.map((s, i) => `<button class="session" aria-pressed="${h.id === selected && i === 1}"><span class="dot ${h.state === "offline" ? "" : s.dot}"></span><span><strong>${s.name}</strong><small>${esc(s.status)}</small></span></button>`).join("");
    const dot = h.state === "connected" ? "good" : h.state === "offline" ? "warn" : "";
    return `<section class="hostgroup ${h.state}"><button class="hostbutton" aria-pressed="${h.id === selected}"><span class="hosticon">${ICON_HOST}</span><span class="hostidentity"><strong>${h.id}</strong><small class="hostmeta"><span class="dot ${dot}"></span>${esc(h.meta)} · ${h.sessions.length} ${h.sessions.length === 1 ? "session" : "sessions"}</small></span></button><div class="host-sessions">${sessions}</div></section>`;
  }).join("");
  const pending = opts.pending ? `<section class="hostgroup pending"><button class="hostbutton" aria-pressed="false"><span class="hosticon">${ICON_HOST}</span><span class="hostidentity"><strong>${opts.pending}</strong><small class="hostmeta"><span class="dot"></span>Waiting for agent to join</small></span></button></section>` : "";
  return `<nav class="sidebar" aria-label="Hosts and sessions"><div class="sidebarhead"><span>Hosts</span><span>${HOSTS.length + (opts.pending ? 1 : 0)}</span></div>${hosts}${pending}<button class="addhost" aria-expanded="${!!opts.addOpen}">${ICON_PLUS}Add host</button><div class="sidebarfoot"><strong>fleet-server</strong><span>State is kept on the server</span><span>Hosts connect out, open no ports</span><span>This browser is a client</span></div></nav>`;
}

function terminals() {
  return HOSTS[0]!.sessions.map((s, i) => `<article class="terminal ${i === 1 ? "active" : ""}"><header class="termhead"><strong><span class="dot good"></span>${s.name}</strong><small>Read-only · live</small></header><div class="transcript">${s.lines.map(([c, t]) => `<span class="${c}">${esc(t)}</span>`).join("\n")}</div><footer class="termfooter"><span>${esc(s.status.split(" · ")[1] ?? "")}</span><code>mac-mini · fleet attach --read-only</code></footer></article>`).join("");
}

function inspector() {
  return `<aside id="requestsPanel" class="inspector coordination" aria-label="Requests from all hosts and supervisor workflow">
<header class="coordinationhead"><h2>Requests</h2><small>All hosts · 3 open</small></header>
<div class="coordinationbody">
<section class="queue">
 <div class="queueitem">
  <div class="queueline"><span class="hosttag">mac-mini</span><span class="requeststatus">Needs your decision</span></div>
  <h2 class="requesttitle">Continue to the read API?</h2>
  <p class="requestcopy">Phase 2 passed verification and review. Approve work on phase 3 within the existing scope.</p>
  <p class="requestref">req-17 · demo-42 · phase 2 · revision 7</p>
  <details class="requestevidence"><summary>View evidence and scope</summary><dl><div><dt>Worker tests</dt><dd>exit 0</dd></div><div><dt>Orchestrator rerun</dt><dd>exit 0</dd></div><div><dt>Review</dt><dd>accepted</dd></div></dl><p class="fineprint">Read API only. No dependency changes, push, merge or deployment.</p></details>
  <div class="requestactions"><button class="primary">Approve phase 3</button><button>Decline</button></div>
 </div>
 <div class="queueitem compact">
  <div class="queueline"><span class="hosttag">build-box</span><span class="requeststatus">Needs your decision</span></div>
  <h2 class="requesttitle">Allow bun install for the new test runner?</h2>
  <p class="requestref">req-04 · release-3 · phase 1 · revision 2</p>
  <div class="requestactions"><button class="primary">Approve</button><button>Decline</button><button>Open</button></div>
 </div>
 <div class="queueitem compact unknown">
  <div class="queueline"><span class="hosttag">rtx-desktop</span><span class="requeststatus">Host offline · state unknown</span></div>
  <h2 class="requesttitle">Keep the checkpoint with lower eval loss?</h2>
  <p class="requestref">req-09 · train-7 · phase 3 · revision 4</p>
  <p class="hostscope">Last known request. Its current status is unknown. Revalidation after reconnect is proposed.</p>
 </div>
</section>
<section class="workflow"><div class="sectionheading"><h3>Workflow · mac-mini</h3><small>task-control-api</small></div><p class="phase-note">phase 2 · revision 7 · awaiting approval</p><ol><li><span class="stepmark done">✓</span><span>Contract</span><small>Done</small></li><li><span class="stepmark wait">2</span><span>Commands</span><small>Awaiting approval</small></li><li><span class="stepmark">3</span><span>Read API</span><small>Next</small></li></ol></section>
<details class="exchange"><summary>Commands &amp; responses · mac-mini</summary><ol><li><div class="exchangemeta"><strong>mariusz → supervisor</strong><time>09:38</time></div><p>Implement command acknowledgements.</p><span class="receipt">cmd-16 · Accepted, not finished</span></li></ol></details>
</div>
<form class="instructionform"><label for="instruction">Instruction to supervisor on mac-mini</label><textarea id="instruction" rows="2" placeholder="Clarify the scope or give an instruction..."></textarea><div class="composerfooter"><span>To worker-api on mac-mini · via server</span><button type="button" disabled>Send</button></div><p role="status">Queued on the server first, then delivered by the host agent.</p></form>
</aside>`;
}

function titlebar(context: string, sub: string) {
  return `<header class="titlebar"><div class="identity"><h1>Fleet Control</h1><div class="hostcontext"><strong>${context}</strong><small>${sub}</small></div></div><div class="tools"><span class="serverstate"><span class="dot good"></span><span>Server</span><strong>fleet-server</strong><span>· live</span></span><button type="button" class="iconbutton" id="panelToggle" aria-controls="requestsPanel" aria-expanded="true" aria-label="Toggle requests panel" title="Toggle requests panel">${ICON_PANEL}</button></div></header>`;
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<script>const theme=new URLSearchParams(location.search).get("theme");if(theme==="dark"||theme==="light")document.documentElement.dataset.theme=theme;</script>
<style>${baseCss}
${extraCss}</style>
</head>
<body>
${body}
<script>const toggle=document.getElementById('panelToggle');const panel=document.getElementById('requestsPanel');if(toggle&&panel){toggle.setAttribute('aria-expanded',String(!matchMedia('(max-width:900px)').matches));toggle.addEventListener('click',()=>{if(matchMedia('(max-width:900px)').matches){panel.classList.toggle('mobile-open');toggle.setAttribute('aria-expanded',String(panel.classList.contains('mobile-open')))}else{panel.hidden=!panel.hidden;document.querySelector('.main').classList.toggle('only-terminal',panel.hidden);toggle.setAttribute('aria-expanded',String(!panel.hidden))}})}</script>
</body>
</html>
`;
}

const deckShell = (extra = "", opts: { pending?: string; addOpen?: boolean } = {}) => `<div class="shell">${titlebar("mac-mini", "Mac mini · 3 sessions · live")}<div class="body">${sidebar("mac-mini", opts)}<main class="main"><div class="alert">rtx-desktop disconnected 4 min ago. Its sessions are shown with their last known state; execution state is unknown, not stopped.</div><div class="workarea"><section class="terminals" aria-label="Session terminals">${terminals()}</section>${inspector()}</div></main></div><footer class="statusbar"><span>Live via fleet-server · read-only terminals · 2 of 3 hosts connected</span><span>Sample data · no live connection</span></footer></div>${extra}`;

const addHost = `<div class="sheetwrap"><section class="sheet" role="dialog" aria-labelledby="addtitle">
<header><h2 id="addtitle">Add host</h2><small>Step 2 of 3</small></header>
<div class="field"><label for="hostname">Host name</label><input id="hostname" value="rtx-desktop-2" spellcheck="false"></div>
<ol class="steps">
 <li class="done"><span>Install the CLI on the host<small>One file, no Bun needed. macOS arm64 or Linux x64. Requires tmux and agent-fleet.</small></span></li>
 <li class="wait"><span>Run this on the host<div class="cmd"><code>fleet-control agent join https://fleet-server:4871 \\
  --name rtx-desktop-2 --code K7Q4-MDPX-2RHW</code><button type="button">Copy</button></div><small>The code works once and expires in 14:52. The host opens no port; it connects out to the server.</small></span></li>
 <li><span>Waiting for the agent to connect<small>The host appears in the sidebar with its sessions once the agent reports in.</small></span></li>
</ol>
<div class="sheetactions"><small>Optional on the host: <code>fleet-control agent install-service</code></small><span><button type="button">Revoke code</button> <button type="button">Close</button></span></div>
</section></div>`;

const signIn = `<main class="signin"><form class="signincard">
<h1>Fleet Control</h1>
<p>Sign in to the server. It holds hosts, sessions, requests and history for every host.</p>
<label for="token">Access token</label>
<input id="token" type="password" value="••••••••••••••••" spellcheck="false">
<p class="signinerror">That token is not valid for this server.</p>
<button type="button" class="go">Sign in</button>
<div class="server"><span>fleet-server:4871</span><span>TLS · certificate trusted</span></div>
</form></main>`;

function write(target: string, draft: string, version: number, html: string, meta: object) {
  const dir = `${root}drafts/${target}/${draft}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/v${version}.html`, html);
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2) + "\n");
}

const proposedCommon = [
  "Central server (Hono on Bun + PostgreSQL) holding hosts, sessions, requests, commands and history; does not exist yet.",
  "Host agent that connects out to the server, reports sessions, heartbeats and delivery outcomes; does not exist yet.",
  "Live push instead of 3 s / 15 s polling.",
];

write("console", "central-server", 1, page("Fleet Control: central server", deckShell()), {
  title: "Central server deck",
  direction: "Same Terminal Deck, fed by one server: real host connection state in the sidebar and one request queue for all hosts on the right.",
  status: "candidate",
  versions: { v1: { parent: { draft: "terminal-deck", version: 4 } } },
  proposed: [
    ...proposedCommon,
    "Host connection state, agent version and disconnect time in the sidebar (from agent heartbeats).",
    "Request queue across hosts with a host tag; offline requests require revalidation before action.",
    "Server connection indicator in the titlebar.",
    "Add host entry point in the sidebar.",
  ],
  notes: "Layout, tokens and panel order are unchanged from the selected Terminal Deck. Workflow, commands and composer stay scoped to the selected host. Host names, models and versions are sample data.",
});

write("add-host", "central-server", 1, page("Fleet Control: add host", deckShell(addHost, { pending: "rtx-desktop-2", addOpen: true })), {
  title: "Add host",
  direction: "Add a host from the GUI: one-time join code and a copyable command, the owner runs it on the host.",
  status: "candidate",
  versions: { v1: {} },
  proposed: [
    ...proposedCommon,
    "`fleet-control agent join` and one-time join codes with expiry and revoke; `agent install-service` for launchd/systemd.",
    "Pending host row until the agent connects.",
  ],
  notes: "Parent is console/central-server v1 (cross-target, recorded in notes because version lineage resolves within a target). The sheet is anchored over the deck so the sidebar stays visible.",
});

write("sign-in", "central-server", 1, page("Sign in · Fleet Control", signIn), {
  title: "Server sign-in",
  direction: "Existing token sign-in, now for the server instead of one host, with the server address and TLS state shown.",
  status: "candidate",
  versions: { v1: {} },
  proposed: ["Server address and certificate state on the sign-in card."],
  notes: "Based on web/login.html. The error line is shown on purpose to review the error state.",
});
console.log("built");
