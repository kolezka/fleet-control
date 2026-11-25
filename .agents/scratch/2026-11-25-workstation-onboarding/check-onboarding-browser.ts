import page from '../../../web/add-host.html';
import { strict as assert } from 'node:assert';
const writes: string[] = [];
const plans: unknown[] = [];
const pending: unknown[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, routes: { '/add-host': page }, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (req.method === 'POST') writes.push(path);
  if (path === '/api/enroll/plans') {
    if (req.method === 'GET') return Response.json({ plans });
    plans.push(await req.json()); return Response.json({ saved: true }, { status: 201 });
  }
  if (path === '/api/enroll') {
    if (req.method === 'GET') return Response.json({ pending });
    const input = await req.json(); assert.equal(input.mode, 'connect');
    const item = { ...input, ssh: null, command: 'fixture only', createdAt: new Date().toISOString() }; pending.push(item);
    return Response.json({ pending: item }, { status: 201 });
  }
  return new Response(null, {status: 404});
}});
const session = `fleet-onboarding-${process.pid}`;
const run = async (...args: string[]) => { console.log(args.join(' ')); return (await Bun.$`agent-browser --session ${session} ${args}`.quiet()).text().trim(); };
try {
  await run('open', `${server.url}add-host`);
  await run('wait', '--text', 'No saved plans');
  await run('click', '#mode-fresh');
  for (const [id, value] of Object.entries({ hostName:'Fixture builder', hostId:'builder', hostUrl:'https://builder.invalid:4872', principal:'gateway', dir:'/srv/fleet', ref:'main',port:'4872',label:'builder',fleet:'workers',tlsCert:'/tls/cert',tlsKey:'/tls/key' })) await run('fill', `#${id}`, value);
  await run('click', '#begin');
  assert.match(await run('get','text','#planSummary'),/builder.invalid:4872/); assert.deepEqual(writes,[]);
  await run('click','#savePlan'); await run('wait','--fn',"document.querySelector('#savedPlans').textContent.includes('Fixture builder')");
  assert.deepEqual(writes,['/api/enroll/plans']); assert.equal(await run('get','text','#pendingCount'),'None');
  await run('click','#mode-connect'); await run('fill','#hostId','existing'); await run('fill','#hostName','Existing runner'); await run('fill','#hostUrl','https://existing.invalid:4872');
  await run('click','#begin'); await run('wait','--text','Token made for existing. Nothing ran on the host yet.');
  assert.deepEqual(writes,['/api/enroll/plans','/api/enroll']); assert.equal(await run('get','text','#pendingCount'),'1');
  console.log(JSON.stringify({writes,savedPlans:plans.length,pendingExisting:pending.length,notice:await run('get','text','#formStatus')}));
} catch(err) {console.error(await run('snapshot'),writes);throw err} finally {try {await run('close')} finally {server.stop(true)}}
