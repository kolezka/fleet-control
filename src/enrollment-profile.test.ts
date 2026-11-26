import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrollUseCases } from './application/enrollment.ts';
import { workstationPlanUseCases } from './application/workstation-plans.ts';
import { workstationPlansFile } from './data/workstation-plans.ts';
import { loadGatewayConfig } from './client-gateway.ts';
import { enrollDeps, enrollHandler, gatewayEnrollment } from './gateway-enroll.ts';
import { checkEnrollRequest, pasteCommand } from './domain/enrollment.ts';
import { createHash } from 'node:crypto';

const profile = { group: 'Build', description: 'Release workers', defaultHarness: 'claude-code' } as const;
const connect = { id: 'build', name: 'Builder', mode: 'connect', principal: 'gateway', dir: '/srv/fleet', url: 'https://fixture.invalid:4872' };
const fresh = { ...connect, mode: 'fresh', ref: 'main', port: 4872, label: 'builder', fleet: 'workers', tlsCert: '/cert', tlsKey: '/key' };
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
for (const input of [connect, fresh]) test(`${input.mode} profile survives verified enrollment and gateway reload`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-profile-'));
  const path = join(dir, 'client.json');
  writeFileSync(path, '{"hosts":[]}');
  const config = await loadGatewayConfig(path, { allowNoHosts: true });
  const token = 'fixture-value-01234567890123456789';
  let role = 'agent';
  const use = enrollHandler(enrollUseCases({ ...enrollDeps(path, config, { ssh: false }), newToken: () => token, whoami: async () => ({ status: 200, body: { auth: true, principal: 'gateway', role } }) }));
  for (const invalid of [null, { ...profile, tokenFile: '/secret' }, { ...profile, defaultHarness: 'observed' }, { ...profile, group: '' }]) {
    expect((await use('POST', '', bytes({ ...input, profile: invalid }))).status).toBe(400);
  }
  expect(readdirSync(dir)).toEqual(['client.json']);
  if (input.mode === 'fresh') {
    const plans = () => gatewayEnrollment(path, config, workstationPlanUseCases(workstationPlansFile(join(dir, 'plans.sqlite')), () => []), { ssh: false });
    expect((await plans()('POST', '/plans', bytes({ ...input, profile: { ...profile, observed: true } }))).status).toBe(400);
    expect((await plans()('POST', '/plans', bytes({ ...input, profile }))).status).toBe(201);
    expect(await plans()('GET', '/plans', null)).toEqual({ status: 200, body: { plans: [{ ...input, profile }] } });
    expect(readdirSync(dir).sort()).toEqual(['client.json', 'plans.sqlite']);
  }
  const begun = await use('POST', '', bytes({ ...input, profile: { ...profile, group: ' Build ' } }));
  expect(begun.status).toBe(201);
  expect(begun.body).toMatchObject({ pending: { profile, command: pasteCommand(checkEnrollRequest(input), createHash('sha256').update(token).digest('hex')) } });
  expect(JSON.stringify(begun.body)).not.toContain(token);
  expect((await use('POST', '/build/check', null)).body).toMatchObject({ added: false });
  expect(config.hosts).toEqual([]);
  expect(JSON.parse(readFileSync(path, 'utf8')).hosts).toEqual([]);
  role = 'operator';
  expect((await use('POST', '/build/check', null)).body).toMatchObject({ added: true });
  expect(config.hosts[0]?.profile).toEqual(profile);
  expect((await loadGatewayConfig(path)).hosts[0]?.profile).toEqual(profile);
});
