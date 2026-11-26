// Bun + agent-browser. Serves product HTML on loopback; never starts a gateway or host.
import assert from 'node:assert/strict';
import home from '../web/index.html';
import workstation from '../web/workstation.html';
import onboarding from '../web/add-host.html';

let capabilities = true, unavailable = false;
const methods = new Set<string>();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, development: false,
  routes: { '/': home, '/workstation': workstation, '/add-host': onboarding },
  fetch(req) {
    methods.add(req.method);
    if (req.method !== 'GET') return new Response(null, {status: 405});
    const path = new URL(req.url).pathname;
    if (path === '/api/hosts') return unavailable ? new Response(null, {status: 503}) : Response.json({ manage: capabilities, enroll: capabilities, hosts: [{id: 'bench', name: 'Fixture bench', group: 'Lab', apiBase: '/api/hosts/bench'}] });
    if (path.endsWith('/profile')) return Response.json({name: 'Fixture bench', origin: 'https://fixture.invalid', profile: null});
    if (path.endsWith('/sessions')) return Response.json({ sessions: [{ name: 'idle', registered: true, running: false, model: {state:'not_applicable'} }] });
    if (path.endsWith('/plans')) return Response.json({plans: []});
    if (path.endsWith('/enroll')) return Response.json({pending: []});
    if (path.endsWith('/requests')) return Response.json({requests: [], runs: []});
    if (path.endsWith('/commands')) return Response.json({commands: []});
    return new Response(null, {status: 404});
  },
});
const session = `studio-editors-${process.pid}`;
const run = async (...args:string[]) => (await Bun.$`agent-browser --session ${session} ${args}`.quiet()).text().trim();
const open = (path:string) => run('open', new URL(path,server.url).href);
const check = async (expression:string) => assert.equal(await run('eval',expression),'true',expression);
try {
  await run('set','viewport','1440','900');
  for (const path of ['/add-host','/workstation?host=bench']) {
    await open(path); await run('wait','--text','Fixture bench');
    await check(`document.querySelectorAll('#studioNavigation [data-view]').length === 8`);
    const railWidth = path === '/add-host' ? 220 : 195;
    await check(`document.querySelector('.studio-navigation').getBoundingClientRect().width === ${railWidth}`);
    await check(`document.querySelector('.titlebar').getBoundingClientRect().height === 52 && document.querySelector('.statusbar').getBoundingClientRect().top === innerHeight - 39`);
    await run('eval',`document.querySelector('main').scrollTop = 500`);
    await check(`document.querySelector('main').scrollTop > 0 && document.scrollingElement.scrollHeight === innerHeight`);
  }
  await run('wait','--text','idle');
  await run('click','[data-view=settings]'); await run('wait','[data-pref=theme]');
  await run('select','[data-pref=theme]','dark'); await run('click','[data-apply-prefs]');
  await run('click','a[href="./add-host"]'); await run('wait','--text','Fixture bench');
  await check(`getComputedStyle(document.body).backgroundColor === 'rgb(23, 25, 28)'`);
  await open('/workstation?host=bench'); await run('wait','--text','idle');
  await check(`document.documentElement.dataset.theme === 'dark'`);
  await run('click','[data-view=tasks]'); await run('wait','--fn',`document.querySelector('#studioCrumb').textContent.includes('Tasks')`);
  await check(`document.documentElement.dataset.theme === 'dark'`);
  capabilities = false;
  await open('/workstation?host=bench'); await run('wait','--text','Fixture bench');
  await check(`document.querySelectorAll('.tree-action').length === 0`);
  await run('set','viewport','390','844'); await run('click','#navigationToggle');
  await check(`document.querySelector('#studioNavigation').getBoundingClientRect().width > 0`);
  await run('press','Escape'); await check(`document.activeElement.id === 'navigationToggle'`);
  unavailable = true; await open('/add-host'); await run('wait','--text','Cannot read gateway inventory');
  await check(`!document.querySelector('.tree-action,.hostgroup')`);
  const key = 'fleet-control:studio:display:v1';
  await run('eval', `sessionStorage.setItem('${key}', '{bad')`); await open('/add-host');
  await check(`document.documentElement.dataset.theme === 'light'`);
  await run('eval', `sessionStorage.setItem('${key}', JSON.stringify({theme:'system',font:'999',extra:'discard me'}))`);
  await open('/workstation?host=bench'); await check(`!document.documentElement.hasAttribute('data-theme')`);
  unavailable = false; await run('set','viewport','1440','900'); await open('/?view=settings'); await run('wait','[data-pref=theme]');
  await run('select','[data-pref=theme]','dark'); await run('click','[data-apply-prefs]');
  await check(`JSON.parse(sessionStorage.getItem('${key}')).font === '13' && !('extra' in JSON.parse(sessionStorage.getItem('${key}')))`);
  assert.deepEqual([...methods], ['GET']);
  console.log('Passed: editor navigation, inventory, viewport chrome, mobile drawer, tab theme, gateway capability and error states; GET only.');
} finally { try { await run('close'); } finally { server.stop(true); } }
