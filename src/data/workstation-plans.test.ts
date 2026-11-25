import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workstationPlans, workstationPlansFile } from './workstation-plans.ts';

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

test('reading plans never creates or changes the store file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-plan-file-'));
  const path = join(dir, 'plans.sqlite');
  const store = workstationPlansFile(path);
  // Nothing saved yet: an empty list, and no file left behind by the read.
  expect(store.list()).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
  // Positive control: the same store writes and reads back through the file.
  store.save(plan);
  expect(existsSync(path)).toBe(true);
  expect(workstationPlansFile(path).list()).toEqual([plan]);
});

test('a store file that is not a plan store is a read error, not an empty list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-plan-bad-'));
  // A valid SQLite file without the plans table: the read must not add the table.
  const other = join(dir, 'other.sqlite');
  const db = new Database(other);
  try { db.run('CREATE TABLE unrelated (x TEXT)'); } finally { db.close(); }
  expect(() => workstationPlansFile(other).list()).toThrow(/workstation_plans/);
  const check = new Database(other, { readonly: true });
  try { expect(check.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: 'unrelated' }]); } finally { check.close(); }
  // Not a database at all.
  const garbage = join(dir, 'garbage.sqlite');
  writeFileSync(garbage, 'this is not a database, '.repeat(64));
  const before = readFileSync(garbage, 'utf8');
  expect(() => workstationPlansFile(garbage).list()).toThrow();
  expect(readFileSync(garbage, 'utf8')).toBe(before);
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
