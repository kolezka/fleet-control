import page from '../../../web/index.html';
import assert from 'node:assert/strict';
const base = { phase: 'build', kind: 'approval', proposedAction: 'Fixture change', scope: 'Fixture only', evidence: [], allowedResponses: ['approve', 'decline'], status: 'open', response: null as string | null };
const requests: any[] = [
  { ...base, projectId: 'Atlas', taskId: 'task0', id: 'request0', runId: 'run0', revision: 3, question: 'Approve Atlas fixture?' },
  { ...base, projectId: 'Beacon', taskId: 'task1', id: 'request1', runId: 'run1', revision: 4, question: 'Approve Beacon fixture?' },
  { ...base, projectId: null, taskId: null, id: 'request2', runId: 'run2', revision: 5, question: 'Approve unowned fixture?' },
  { ...base, projectId: null, taskId: null, id: 'request3', runId: 'run3', revision: '7"><img id="injected" src="x">', question: 'Hostile revision fixture?' },
  { ...base, projectId: 'Atlas', taskId: null, id: 'request4', runId: 'run4', revision: 6, question: 'Half owner fixture?' },
];
const writes: unknown[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, routes: { '/': page }, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (req.method === 'POST') {
    const body = await req.json(); writes.push({ path, body });
    const hit = requests.find((q) => path === `/api/hosts/shared/requests/${q.id}/resolve`);
    if (!hit) return new Response(null, { status: 404 });
    Object.assign(hit, { status: 'resolved', response: body.response });
    return Response.json({ request: hit });
  }
  if (path === '/api/hosts') return Response.json({ hosts: [{ id: 'shared', name: 'Shared workstation', apiBase: '/api/hosts/shared' }] });
  if (path.endsWith('/requests')) return Response.json({ runs: [], requests });
  if (path.endsWith('/sessions')) return Response.json({ sessions: [] });
  if (path.endsWith('/commands')) return Response.json({ commands: [] });
  return new Response(null, { status: 404 });
} });
const session = `fleet-decision-${process.pid}`;
const run = async (...args: string[]) => (await Bun.$`agent-browser --session ${session} ${args}`.quiet()).text().trim();
try {
  await run('open', String(server.url));
  await run('wait', '[data-project="Beacon"]');
  assert.equal(await run('get', 'count', '#requests [data-answer]'), '0');
  assert.equal(await run('get', 'count', '#injected'), '0');
  assert.match(await run('get', 'text', '#requests'), /Project and task not assigned\./);
  assert.match(await run('get', 'text', '#requests'), /Half owner fixture\?[\s\S]*Project and task could not be read\. This request cannot be answered\./);
  assert.equal(await run('get', 'count', '#requests [data-unassigned]'), '2');

  await run('click', '[data-project="Atlas"]');
  const review = await run('get', 'text', '#projectReview');
  assert.match(review, /Approve Atlas fixture/);
  assert.doesNotMatch(review, /Beacon|unowned|Hostile|Half owner/);
  await run('click', '#projectReview [data-answer="approve"]');
  await run('wait', '--text', 'Recorded: approve');
  assert.deepEqual(writes, [{ path: '/api/hosts/shared/requests/request0/resolve', body: { response: 'approve', expectedRevision: 3 } }]);
  assert.equal(await run('get', 'count', '#projectReview [data-answer]'), '0');

  await run('click', '[data-close-review]');
  // The supervisor panel scrolls; the button can sit below its visible part.
  await run('scrollintoview', '#requests [data-unassigned]');
  await run('click', '#requests [data-unassigned]');
  const unassigned = await run('get', 'text', '#projectReview');
  assert.match(unassigned, /No project assigned/);
  assert.match(unassigned, /Approve unowned fixture/);
  assert.match(unassigned, /Hostile revision fixture/);
  assert.doesNotMatch(unassigned, /Atlas|Beacon|Half owner/);
  assert.equal(await run('get', 'count', '#projectReview [data-request="request4"]'), '0');
  assert.equal(await run('get', 'count', '#injected'), '0');
  await run('click', '#projectReview [data-request="request2"][data-answer="decline"]');
  await run('wait', '--text', 'Recorded: decline');
  assert.deepEqual(writes[1], { path: '/api/hosts/shared/requests/request2/resolve', body: { response: 'decline', expectedRevision: 5 } });
  // The hostile revision is not a number, so its button must not send anything.
  await run('click', '#projectReview [data-request="request3"][data-answer="approve"]');
  await Bun.sleep(500);
  assert.equal(writes.length, 2);
  assert.equal(requests[1].status, 'open');
  assert.equal(requests[3].status, 'open');
  assert.equal(requests[4].status, 'open');
  console.log(JSON.stringify({ writes, unassigned: await run('get', 'text', '#projectReview'), beacon: requests[1].status, hostile: requests[3].status, half: requests[4].status, injected: await run('get', 'count', '#injected') }));
} catch (err) { console.error(await run('snapshot')); throw err; } finally { try { await run('close'); } finally { server.stop(true); } }
