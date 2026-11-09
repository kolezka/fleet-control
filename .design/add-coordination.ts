import { readFileSync, writeFileSync } from "node:fs";

const folder = "/Users/me/Development/fleet-control/.design/drafts/console/terminal-deck";
let html = readFileSync(`${folder}/v3.html`, "utf8");
const oldInspector = html.match(/<aside class="inspector"[\s\S]*?<\/aside>/)?.[0];
if (!oldInspector) throw new Error("Inspector not found");

const inspector = `<aside class="inspector coordination" id="phaseInspector" aria-label="Supervisor requests and workflow">
<header class="coordinationhead"><h2>Supervisor</h2><small>runner-01 · demo-42</small></header>
<section class="request"><div class="sectionheading"><h3>Request</h3><span class="requeststatus" id="requestStatus">Needs your decision</span></div><h2 class="requesttitle">Continue to the read API?</h2><p class="requestcopy">Phase 2 passed verification and review. Approve work on phase 3 within the existing scope.</p><p class="requestref">req-17 · phase 2 · revision 7</p><details class="requestevidence"><summary>View evidence and scope</summary><dl id="evidenceRows"></dl><p class="fineprint">Example revision <code>a1b2c3d</code>. Read API only. No dependency changes, push, merge or deployment.</p></details><div class="requestactions"><button type="button" id="approve">Approve phase 3</button><button type="button" id="rejectRequest">Decline</button></div><button type="button" id="clarify" class="questionlink">Ask a question</button><p class="requestresult" id="requestResult" aria-live="polite"></p></section>
<section class="workflow"><div class="sectionheading"><h3>Workflow</h3><small>task-control-api</small></div><p id="phaseState" class="phase-note">Awaiting approval</p><ol id="workflowSteps"></ol></section>
<details class="exchange" open><summary>Commands &amp; responses</summary><ol id="exchangeRows"></ol><p id="eventText" class="fineprint"></p></details>
<form id="instructionForm" class="instructionform"><label for="instruction">Instruction to supervisor</label><textarea id="instruction" rows="2" maxlength="1000" placeholder="Clarify the scope or give an instruction..."></textarea><div class="composerfooter"><span>Browser → supervisor</span><button type="submit" id="sendInstruction" disabled>Send</button></div><p id="instructionStatus" role="status">Demo only. No API is connected.</p></form>
</aside>`;
html = html.replace(oldInspector,inspector);
const styles = `
/* Requests come first; evidence is disclosed on demand, separate from the terminal transcript. */
.workarea{grid-template-columns:minmax(0,1fr) 330px}.coordination{padding-top:18px;gap:20px}.coordinationhead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.coordinationhead h2{font-size:13px}.coordinationhead small{font-size:10px}.sectionheading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.sectionheading h3{font-size:11px;font-weight:500;color:var(--muted)}.sectionheading small{font-size:10px}.requeststatus{font-size:10px;color:var(--warn)}.requesttitle{font-size:14px;line-height:1.5;margin-bottom:7px}.requestcopy{font-size:11px;color:var(--muted);line-height:1.65}.requestref{font:10px var(--mono);color:var(--muted);margin-top:10px}.requestevidence{font-size:11px;margin-top:12px}.requestevidence summary{cursor:pointer;color:var(--accent)}.requestevidence dl{margin:10px 0;font-size:11px}.requestevidence dl div{display:flex;justify-content:space-between;gap:8px;margin:6px 0}.requestevidence dt{color:var(--muted)}.requestevidence dd{margin:0}.requestactions{display:flex;gap:8px;margin-top:13px}.requestactions button{font-size:11px;padding:7px 12px;border-color:var(--line)}.requestactions #approve{background:var(--ink);color:var(--surface);flex:1}.questionlink{font-size:11px;color:var(--muted);padding:6px 0;margin-top:3px}.requestresult{font-size:10px;color:var(--muted);line-height:1.6}.requestresult:empty{display:none}.workflow,.exchange,.instructionform{border-top:1px solid var(--line);padding-top:16px}.workflow .phase-note{font-size:10px;margin-bottom:10px}.workflow ol{list-style:none;margin:0;padding:0;display:grid;gap:9px}.workflow li{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:8px;font-size:11px}.stepmark{width:15px;height:15px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;font-size:9px;color:var(--muted)}.stepmark.done{color:var(--good)}.stepmark.wait{color:var(--warn);border-color:var(--warn)}.workflow li small{font-size:10px}.exchange summary{font-size:11px;font-weight:500;cursor:pointer}.exchange ol{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:13px}.exchange li{font-size:11px;min-width:0}.exchangemeta{display:flex;gap:8px;align-items:baseline;margin-bottom:3px}.exchangemeta strong{font-size:10px;font-weight:500}.exchangemeta time{font-size:9px;color:var(--muted);margin-left:auto}.exchange p{font-size:11px;line-height:1.6;overflow-wrap:anywhere}.exchange .receipt{display:block;color:var(--muted);font-size:10px;margin-top:3px}.exchange .fineprint{font-size:10px;margin-top:9px}.instructionform{display:grid;gap:9px;margin-top:auto}.instructionform label{font-size:11px;font-weight:500}.instructionform textarea{width:100%;resize:vertical;min-height:64px;max-height:160px;padding:9px 10px;background:var(--terminal);color:var(--ink);border:1px solid var(--line);border-radius:4px;font:12px/1.6 var(--sans)}.instructionform textarea::placeholder{color:var(--muted)}.instructionform textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.composerfooter{display:flex;justify-content:space-between;align-items:center;gap:10px}.composerfooter span{font-size:10px;color:var(--muted)}.composerfooter button{font-size:11px;border-color:var(--line);padding:5px 13px}.instructionform #instructionStatus{font-size:10px;color:var(--muted);line-height:1.5}.only-terminal .workarea{grid-template-columns:minmax(0,1fr)}@media(max-width:1100px){.workarea{grid-template-columns:minmax(0,1fr) 300px}}@media(max-width:900px){.workarea{grid-template-columns:minmax(0,1fr)}.coordination{width:min(330px,calc(100vw - 24px))}}
`;
html = html.replace("</style>",styles+"</style>");
function change(before:string,after:string){if(!html.includes(before))throw new Error(`Missing replacement: ${before}`);html=html.replace(before,after)}
change("let scaleIndex=0;",`let scaleIndex=0;
state.rejected=false;
const exchanges=[
 {actor:'Your session',text:'Implement command acknowledgements.',receipt:'cmd-16 · accepted by supervisor',time:'09:38'},
 {actor:'Supervisor',text:'Verification and review complete.',receipt:'phase 2 · revision 7',time:'09:41'},
 {actor:'Supervisor',text:'May I start the read API phase?',receipt:'req-17 · waiting for your decision',time:'09:42'}
];
let nextCommand=17;
`);
change("$('approve').disabled=state.approved||state.offline||state.scenario!=='normal';", "$('approve').disabled=state.approved||state.rejected||state.offline||state.scenario!=='normal';");
change("$('approve').textContent=state.approved?'Approved in demo':'Approve next phase';", "$('approve').textContent=state.approved?'Decision queued':state.rejected?'Declined':'Approve phase 3';");
change("$('status').textContent=state.offline?'Disconnected · execution state unknown':state.lease?'Demo input lease · no keystrokes sent':'Read-only · no process attached';", "$('status').textContent=state.offline?'Disconnected · execution state unknown':state.lease?'Demo input lease · no keystrokes sent':'Read-only · no process attached';\n renderCoordination();");
change("if(b.id==='approve'&&!b.disabled){state.approved=true;state.message='Demo approval recorded for phase 2 / revision 7. No command sent.';render()}", "if(b.id==='approve'&&!b.disabled){state.approved=true;state.message='Decision queued in this demo. Supervisor acknowledgement is pending.';exchanges.push({actor:'You',text:'Approved phase 3 within the stated scope.',receipt:'req-17 · revision 7 · awaiting delivery (demo)',time:'Now'});render()}");
change("if(b.id==='clarify'){state.message='Demo clarification requested. No message sent.';render()}", "if(b.id==='clarify'){$('instruction').value='Please clarify the scope of phase 3 before continuing.';$('instruction').focus();state.message='Question drafted. Review it before sending.';render()}");
const insert = `
function renderCoordination(){
 const blocked=state.offline||state.scenario!=='normal';
 $('requestStatus').textContent=state.offline?'State unknown':state.approved?'Awaiting acknowledgement':state.rejected?'Declined':blocked?'Not ready':'Needs your decision';
 $('rejectRequest').disabled=blocked||state.approved||state.rejected;
 $('requestResult').textContent=state.approved?'Approval is queued in this mockup. Phase 3 has not started.':state.rejected?'This request was declined in the mockup. No continuation authorized.':'';
 const next=state.approved?'Waiting for supervisor':state.rejected?'Blocked':blocked?'Waiting for evidence':'Waiting for you';
 $('phaseState').textContent='Phase 2 of 3 · '+next.toLowerCase();
 const rows=[['1','Contract','Complete','done'],['2','Commands',state.scenario==='normal'?'Verified':'Not verified',state.scenario==='normal'?'done':''],['·','Human decision',state.approved?'Queued':state.rejected?'Declined':'Pending','wait'],['3','Read API','Not started','']];
 $('workflowSteps').innerHTML=rows.map(([mark,title,status,kind])=>'<li><span class="stepmark '+kind+'">'+mark+'</span><span>'+title+'</span><small>'+status+'</small></li>').join('');
 $('exchangeRows').innerHTML=exchanges.slice(-5).map(item=>'<li><div class="exchangemeta"><strong>'+esc(item.actor)+'</strong><time>'+esc(item.time)+'</time></div><p>'+esc(item.text)+'</p><span class="receipt">'+esc(item.receipt)+'</span></li>').join('');
 $('sendInstruction').disabled=state.offline||!$('instruction').value.trim();
}
$('instruction').addEventListener('input',()=>{$('sendInstruction').disabled=state.offline||!$('instruction').value.trim()});
$('instructionForm').addEventListener('submit',event=>{
 event.preventDefault();
 if(state.offline){$('instructionStatus').textContent='Disconnected. No instruction queued.';return;}
 const text=$('instruction').value.trim();
 if(!text)return;
 const id='demo-cmd-'+nextCommand++;
 exchanges.push({actor:'You · browser',text,receipt:id+' · queued locally (demo)',time:'Now'});
 $('instruction').value='';
 $('instructionStatus').textContent=id+': queued in this page only. Not delivered or accepted.';
 render();
});
document.addEventListener('click',event=>{
 const button=event.target.closest('button');
 if(button?.id==='rejectRequest'&&!button.disabled){state.rejected=true;state.message='Request declined in this demo. No command was sent.';exchanges.push({actor:'You',text:'Declined the next phase.',receipt:'req-17 · revision 7 · mock decision',time:'Now'});render();}
});
`;
const initialRender = html.lastIndexOf("\nrender();");
if(initialRender<0)throw new Error("Initial render missing");
html=html.slice(0,initialRender)+insert+html.slice(initialRender);
writeFileSync(`${folder}/v4.html`,html,{flag:"wx"});
console.log("Created Terminal Deck v4: supervisor requests, workflow, command receipts and a demo instruction composer.");
