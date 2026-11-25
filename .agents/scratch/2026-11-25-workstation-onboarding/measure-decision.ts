// Layout probe: where the unassigned button sits relative to the instruction form.
import page from '../../../web/index.html';
const base = { phase: 'build', kind: 'approval', proposedAction: 'Fixture change', scope: 'Fixture only', evidence: [], allowedResponses: ['approve', 'decline'], status: 'open', response: null as string | null };
const count = Number(process.env.FC_REQUESTS ?? 4);
const requests = Array.from({ length: count }, (_, i) => ({ ...base, projectId: i < 2 ? `P${i}` : null, taskId: i < 2 ? `t${i}` : null, id: `request${i}`, runId: `run${i}`, revision: i + 3, question: `Approve fixture ${i}?` }));
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, routes: { '/': page }, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/api/hosts') return Response.json({ hosts: [{ id: 'shared', name: 'Shared workstation', apiBase: '/api/hosts/shared' }] });
  if (path.endsWith('/requests')) return Response.json({ runs: [], requests });
  if (path.endsWith('/sessions')) return Response.json({ sessions: [] });
  if (path.endsWith('/commands')) return Response.json({ commands: [] });
  return new Response(null, { status: 404 });
} });
const session = `fleet-measure-${process.pid}`;
const run = async (...args: string[]) => (await Bun.$`agent-browser --session ${session} ${args}`.quiet()).text().trim();
const probe = `JSON.stringify({ vw: innerWidth, vh: innerHeight, items: ['#phaseInspector', '.coordinationbody', '#requests', '#requests [data-unassigned]', '#requests [data-project]', '#instructionForm', '.workflow'].map((s) => { const e = document.querySelector(s); if (!e) return { s, missing: true }; const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return { s, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), sh: e.scrollHeight, ch: e.clientHeight, overflowY: c.overflowY, shrink: c.flexShrink, minH: c.minHeight }; }) })`;
try {
  await run('open', String(server.url));
  await run('wait', '#requests [data-project]');
  console.log(await run('eval', probe));
} finally { try { await run('close'); } finally { server.stop(true); } }
