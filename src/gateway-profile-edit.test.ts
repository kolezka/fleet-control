import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadGatewayConfig, startGateway, Credentials} from './client-gateway.ts';
import {gatewayHostManager} from './gateway-hosts.ts';

test('the profile form is served only with gateway management enabled', async () => {
  const config = { hosts: [], credentials: new Credentials(new Map()) };
  for (const enabled of [false, true]) {
    const gw = startGateway(config, { port: 0, ...(enabled ? {manage: gatewayHostManager('/unused',config)} : {}) });
    try {
      const page = await fetch(new URL('/workstation?host=build',gw.url));
      expect(page.status).toBe(enabled ? 200 : 404);
      if (enabled) expect(await page.text()).toContain('Changes to review');
    } finally { gw.stop(true); }
  }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fc-profile-')), file = join(dir, 'config.json');
  const raw = { id: 'build', name: 'Build', url: 'https://build.example.test', tokenFile: 'token' };
  writeFileSync(file, JSON.stringify({ hosts: [raw] })); writeFileSync(join(dir, 'token'), 'fixture-build-token');
  return { file, raw, config: await loadGatewayConfig(file) };
}
const profile = { group: 'Lab', description: 'Bench', defaultHarness: 'claude-code' };

test("a profile sent without this page's origin is refused and the config file stays as it was", async () => {
  const { file, raw, config } = await fixture();
  const gw = startGateway(config, { port: 0, manage: gatewayHostManager(file, config) });
  try {
    const expected = await (await fetch(new URL('/api/manage/build/profile', gw.url))).json();
    const send = (origin: string | null) => fetch(new URL('/api/manage/build/profile', gw.url), { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ expected, name: 'Lab build', profile }) });
    const before = readFileSync(file, 'utf8');
    for (const origin of [null, 'http://evil.example']) expect((await send(origin)).status).toBe(403);
    expect(readFileSync(file, 'utf8')).toBe(before);
    // Positive control: the same body from the page's own origin is saved.
    expect((await send(gw.url.origin)).status).toBe(200);
    expect(JSON.parse(readFileSync(file, 'utf8')).hosts[0]).toEqual({ ...raw, name: 'Lab build', profile });
  } finally { gw.stop(true); }
});

test('a profile save that fails is logged with its cause and changes nothing in memory', async () => {
  const { file, config } = await fixture();
  const lines: string[] = [];
  const manage = gatewayHostManager(file, config, { log: (l) => lines.push(l) });
  const expected = (await manage('GET', '/build/profile', null)).body;
  const post = (body: unknown) => manage('POST', '/build/profile', new TextEncoder().encode(JSON.stringify(body)));
  // A stale snapshot is a normal refusal, not a failure worth a log line.
  expect((await post({ expected: { ...(expected as object), name: 'Other' }, name: 'Lab build', profile })).status).toBe(409);
  expect(lines).toEqual([]);
  writeFileSync(file, '{ not json');
  expect(await post({ expected, name: 'Lab build', profile })).toEqual({ status: 500, body: { error: { message: 'Cannot update workstation configuration.' } } });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^saving the profile of build failed: .*JSON/);
  expect(config.hosts[0]).toMatchObject({ name: 'Build' });
  expect(config.hosts[0]!.profile).toBeUndefined();
});

test('profile changes require a current snapshot and never change enrollment credentials', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'fc-profile-')), file=join(dir,'config.json');
  const raw={id:'build',name:'Build',url:'https://build.example.test',tokenFile:'token'};
  writeFileSync(file,JSON.stringify({hosts:[raw]}));writeFileSync(join(dir,'token'),'fixture-build-token');
  const config=await loadGatewayConfig(file),manage=gatewayHostManager(file,config);
  const current=await manage('GET','/build/profile',null);
  expect(current.status).toBe(200);
  const expected=current.body, profile={group:'Lab',description:'Bench',defaultHarness:'claude-code'};
  const post=(body:unknown)=>manage('POST','/build/profile',new TextEncoder().encode(JSON.stringify(body)));
  expect((await post({expected,name:'Lab build',profile,url:'https://other.example.test'})).status).toBe(400);
  expect((await post({expected,name:'Lab build',profile})).status).toBe(200);
  expect((await post({expected,name:'Stale writer',profile})).status).toBe(409);
  expect(JSON.parse(readFileSync(file,'utf8')).hosts[0]).toEqual({...raw,name:'Lab build',profile});
  expect((await loadGatewayConfig(file)).hosts).toEqual(config.hosts);
  expect(config.credentials.bearer('build')).toBe('fixture-build-token');
});
