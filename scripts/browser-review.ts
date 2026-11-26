// From the prepared worktree: bun --no-install --no-env-file scripts/browser-review.ts
// Open the printed http://127.0.0.1:<port>/ URL. Ctrl+C stops the fixture.
// No gateway, fleet CLI, PTY, database, token, remote host, or disk build is used.
import { basename, resolve } from 'node:path';
import type { Req, Run } from '../web/host-state';

const createdAt = '2026-11-24T09:30:00Z';
const resolvedAt = '2026-11-24T10:05:00Z';
const host = (id: string, name: string, group: string) => ({ id, name, group, apiBase:`/api/hosts/${id}` });
const alpha = host('alpha', 'Build workstation', 'Engineering');
const beta = host('beta', 'Review workstation', 'Lab');
const sessions = ['supervisor', 'reviewer'].map(name => ({ name, host:alpha.id, role:name, registered:true, running:true, model:{ state:'not_applicable' } }));
const runs: Run[] = sessions.map((s, i) => ({ id:`atlas-${i + 1}`, projectId:'Atlas', taskId:i ? 'A-18' : 'A-17', orchestrator:s.name, phase:'review', revision:3, phaseStatus:'in_progress', updatedAt:createdAt }));
const questions = ['Authorize the read API phase?', 'Authorize fixture review?'];
const owned: Req[] = runs.map((run,i) => ({ id:`review-${i + 1}`, runId:run.id, projectId:run.projectId, taskId:run.taskId, origin:run.orchestrator, phase:run.phase, revision:run.revision, kind:'approval', question:questions[i]!, proposedAction:'Review synthetic results', scope:'Fixture only. No execution.', evidence:['Synthetic verification log'], allowedResponses:['approve','decline'], status:'open', response:null, resolvedBy:null, resolutionNote:null, createdAt }));
const requests: Req[] = [...owned,
  { ...owned[0]!, id:'unassigned', runId:'legacy-review', projectId:null, taskId:null, question:'Who owns the legacy review?' },
  { ...owned[0]!, id:'recorded', revision:2, question:'Accept the synthetic baseline?', status:'resolved', response:'approve', resolvedBy:'Fixture operator', resolvedAt },
];

export async function startBrowserReview() {
  const pages = ['index','add-host','workstation','install'];
  const build = await Bun.build({ entrypoints:pages.map(name => resolve(import.meta.dir, '../web', `${name}.html`)), target:'browser', publicPath:'/' });
  if (!build.success) throw new Error(`Product build failed: ${build.logs.join('\n')}`);
  const assets = new Map(build.outputs.map(asset => {
    const name = basename(asset.path);
    return [name === 'index.html' ? '/' : '/' + name.replace(/\.html$/, ''), asset] as const;
  }));
  const reads = new Map<string,string>();
  const record = (path: string, data: unknown) => reads.set(path, JSON.stringify(data));
  record('/api/hosts', { hosts:[alpha,beta], enroll:true, manage:true });
  record('/api/enroll', { pending:[] });
  record('/api/enroll/plans', { plans:[] });
  for (const h of [alpha,beta]) {
    record(`${h.apiBase}/sessions`, { sessions:h === alpha ? sessions : [], readAt:createdAt });
    record(`${h.apiBase}/requests`, { runs:h === alpha ? runs : [], requests:h === alpha ? requests : [] });
    record(`${h.apiBase}/commands`, { commands:[] });
    record(`/api/manage/${h.id}/profile`, { name:h.name, origin:`https://${h.id}.invalid`, profile:{ group:h.group, description:'Synthetic browser review workstation', defaultHarness:null } });
  }
  const replays = new Map(sessions.map(s => [`${alpha.apiBase}/sessions/${s.name}/terminal`, new TextEncoder().encode(`\x1b]777;fleet-size;80;24\x07Synthetic replay: ${s.name}\r\nAtlas / ${s.name === 'reviewer' ? 'A-18' : 'A-17'}\r\nVerification log loaded. Waiting for review.\r\n`)]));
  return Bun.serve({ hostname:'127.0.0.1', port:0, development:false,
    fetch(req, server) {
      const path = new URL(req.url).pathname;
      const origin = req.headers.get('origin');
      if (req.headers.get('host') !== server.url.host || (origin !== null && origin !== server.url.origin) || req.headers.get('sec-fetch-site') === 'cross-site') return new Response('Forbidden', { status:403 });
      if (req.method !== 'GET') return Response.json({ error:{ message:'Read-only review fixture' } }, { status:405, headers:{ Allow:'GET' } });
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const replay = replays.get(path);
        if (!replay) return new Response('No fixture terminal', { status:404 });
        if (server.upgrade(req, { data:replay })) return;
        return new Response('Invalid upgrade', { status:400 });
      }
      const asset = assets.get(path);
      if (asset) return new Response(asset, { headers:{ 'content-type':asset.type, 'cache-control':'no-store', 'content-security-policy':`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${server.url.host} data:; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'` } });
      const snapshot = reads.get(path);
      if (snapshot !== undefined) return new Response(snapshot, { headers:{ 'content-type':'application/json', 'cache-control':'no-store' } });
      return Response.json({ error:{ message:'Not part of the review fixture' } }, { status:404 });
    },
    websocket:{ data:{} as Uint8Array, open(ws) { ws.sendBinary(ws.data); }, message(ws) { ws.close(1008, 'Read-only review fixture'); } },
  });
}

if (import.meta.main) console.log(`Synthetic, read-only browser review: ${(await startBrowserReview()).url}`);
