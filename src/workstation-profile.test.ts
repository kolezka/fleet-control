import {expect, test} from 'bun:test';
import {parseGatewayConfig} from './client-gateway.ts';

const entry = {id:'build', name:'Build', url:'https://build.example.test', tokenFile:'token-build'};
const parse = (profile: unknown) => parseGatewayConfig({hosts:[{...entry,profile}]}, '/fixture')[0];

test('configured workstation profile round trips without changing the credential destination', () => {
  for (const defaultHarness of ['deepseek-harness','claude-code',null] as const) {
    const profile = {group:'Builders', description:'Linux workers', defaultHarness};
    expect(parse(profile)).toEqual({id:'build', name:'Build', origin:entry.url, tokenFile:'/fixture/token-build', profile});
  }
  expect(parseGatewayConfig({hosts:[entry]}, '/fixture')[0]).not.toHaveProperty('profile');
});

test('workstation profiles reject malformed values, extra fields and credential overrides', () => {
  const ok = {group:'Builders', description:'', defaultHarness:null};
  for (const profile of [null, [], {}, {...ok,group:' '}, {...ok,description:'x\n'}, {...ok,defaultHarness:'other'}, {...ok,url:'https://elsewhere.example.test'}, {...ok,tokenFile:'another'}]) {
    expect(() => parse(profile)).toThrow(/profile/);
  }
});
