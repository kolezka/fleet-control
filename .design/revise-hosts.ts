import { readFileSync, writeFileSync } from "node:fs";

const folder = "/Users/me/Development/fleet-control/.design/drafts/console/terminal-deck";
const source = readFileSync(`${folder}/v1.html`, "utf8");
const sidebarLine = source.split("\n").find(line => line.startsWith(" $('sidebar').innerHTML="));
if (!sidebarLine) throw new Error("Expected sidebar renderer not found");

const sidebar = ` $('sidebar').innerHTML='<div class="sidebarhead"><span>Hosts</span><span>'+new Set(Object.values(SESSIONS).map(s=>s.host)).size+'</span></div>'+['local-dev','runner-01'].map(host=>{
 const sessions=Object.entries(SESSIONS).filter(([,s])=>s.host===host);
 const local=host==='local-dev';
 const icon=local?'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h4M12 17.5h4"/></svg>';
 return '<section class="hostgroup" aria-label="'+host+'"><button class="hostbutton" data-host="'+host+'" aria-pressed="'+(state.host===host)+'"><span class="hosticon">'+icon+'</span><span class="hostidentity"><strong>'+host+'</strong><small>'+(local?'Local':'Remote')+' · '+sessions.length+' '+(sessions.length===1?'session':'sessions')+'</small></span></button><div class="host-sessions">'+sessions.map(([key,s])=>'<button class="session" data-session="'+key+'" aria-pressed="'+(state.selected===key)+'"><span class="dot '+(state.offline?'warn':key==='reviewer'?'good':'')+'"></span><span><strong>'+s.name+'</strong><small>'+ (state.offline?'State unknown':s.status)+'</small></span></button>').join('')+'</div></section>';
 }).join('')+'<div class="sidebarfoot"><strong>task-control-api</strong><span>demo-42 · phase 2 of 3</span><span>Read-only by default</span></div>';`;

const css = `
/* Host headers establish the parent level; indented sessions keep the hierarchy visible. */
.deck .body{grid-template-columns:220px minmax(0,1fr)}
.sidebar{gap:24px;padding-inline:12px}
.sidebarhead{padding-inline:9px}
.hostgroup{display:flex;flex-direction:column;gap:9px}
.hostbutton{gap:10px;padding:8px 8px 8px 5px;border-radius:5px}
.hosticon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:0 0 30px;border:1px solid var(--line);border-radius:6px;background:var(--subtle);color:var(--muted)}
.hosticon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.hostbutton[aria-pressed="true"] .hosticon{color:var(--accent);border-color:var(--active-line);background:var(--selected)}
.hostidentity{display:flex;flex-direction:column;gap:2px;min-width:0}
.hostidentity strong{font-size:13px;font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.hostidentity small{font-size:10px;font-weight:400;color:var(--muted)}
.host-sessions{display:grid;gap:3px;margin-left:19px;padding-left:9px;border-left:1px solid var(--line)}
.host-sessions .session{padding:9px 8px;gap:7px}
.host-sessions .session strong{font-size:12px;font-weight:400}
.host-sessions .session[aria-pressed="true"] strong{font-weight:500}
@media(max-width:700px){.deck .body{grid-template-columns:minmax(0,1fr)}.sidebar{gap:14px}.hostgroup{gap:7px}.host-sessions{grid-template-columns:repeat(3,minmax(0,1fr));margin-left:19px;padding-left:8px}.host-sessions .session{padding:8px 4px;gap:4px}.host-sessions .session strong{font-size:10px}.hostidentity strong{font-size:13px}}
`;
const result = source.replace(sidebarLine, sidebar).replace("</style>", css + "</style>");
writeFileSync(`${folder}/v2.html`, result, { flag: "wx" });
console.log("Created Terminal Deck v2: distinct host headers and nested sessions. v1 preserved.");
