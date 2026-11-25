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
