import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workstationPlans } from './workstation-plans.ts';

const plan = { id: 'build', name: 'Builder', url: 'https://build.example.test:4872', mode: 'fresh' as const, principal: 'gateway', dir: '/srv/new', ref: 'main', port: 4872, label: 'builder', fleet: 'workers', tlsCert: '/tls/cert', tlsKey: '/tls/key' };

test('fresh plan survives reopening and a second writer cannot replace it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fc-plan-')), 'plans.sqlite');
  const a = new Database(path);
  try { workstationPlans(a).save(plan); } finally { a.close(); }
  const b = new Database(path);
  try {
    const store = workstationPlans(b);
    expect(store.list()).toEqual([plan]);
    expect(() => store.save({ ...plan, name: 'Changed' })).toThrow(/already exists/);
    expect(store.list()).toEqual([plan]);
  } finally { b.close(); }
});

test('empty store is distinct from malformed stored data', () => {
  const db = new Database(':memory:');
  try {
    const store = workstationPlans(db);
    expect(store.list()).toEqual([]);
    store.save(plan);
    db.run("UPDATE workstation_plans SET body = 'broken' WHERE id = 'build'");
    expect(() => store.list()).toThrow(/invalid stored workstation plan/);
  } finally { db.close(); }
});

test('rejects registration input and unknown fields before saving', () => {
  const db = new Database(':memory:');
  try {
    const store = workstationPlans(db);
    expect(() => store.save({id:'build',name:'Builder',url:plan.url,principal:'gateway',dir:'/srv',mode:'connect'})).toThrow(/fresh/);
    expect(() => store.save({ ...plan, extra: 'unexpected' })).toThrow(/unknown field/);
    expect(store.list()).toEqual([]);
  } finally { db.close(); }
});
