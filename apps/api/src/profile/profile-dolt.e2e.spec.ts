// Profile values in a REAL Dolt server: a user's own edit goes to main, an administrator's edit stays on the working branch until the merge,
// and a main edit made after the branch was cut merges without conflict. Skipped without DOLT_BIN (or dolt on PATH).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VersioningService } from '../versioning/versioning.service.js';
import { DoltProfileStore } from './store.js';

const root = resolve(process.cwd(), '../..');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? which;
const have = !!doltBin && existsSync(doltBin);
const T = 'acme-demo';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('profile values in real Dolt', { skip: !have && 'dolt binary missing' }, () => {
  let dolt: ChildProcess, dir: string;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-prof-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, v], { env });
    assert.equal(spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) }).status, 0);
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', '13312', '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    Object.assign(process.env, { DOLT_PORT: '13312', DOLT_DATABASE: 'iam' });
    for (let i = 0; i < 100; i++) { if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', '13312', '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await sleep(150); }
  });
  after(async () => { dolt?.kill(); await sleep(800); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('live edits commit to main; admin edits stay on the branch until merged; a main edit after the branch was cut does not conflict', async () => {
    const v = new VersioningService(); const branch = 'work-profile';
    const store = new DoltProfileStore(v, () => branch);
    assert.deepEqual(await store.get(T, 'demo-alice', 'live'), {}, 'no table yet: empty, not an error');
    await store.put(T, 'demo-alice', { 'hr-attributes.job_title': 'Accountant' }, 'live', 'demo-alice');
    await v.lock(() => v.at('main', async (c) => { await c.query("call dolt_branch(?)", [branch]); }));
    await store.put(T, 'demo-bob', { 'hr-attributes.employee_grade': 'G3' }, 'work', 'admin');
    assert.deepEqual(await store.get(T, 'demo-bob', 'live'), {}, 'main untouched by the admin edit');
    assert.deepEqual(await store.get(T, 'demo-bob', 'work'), { 'hr-attributes.employee_grade': 'G3' });
    assert.deepEqual(await store.get(T, 'demo-alice', 'work'), { 'hr-attributes.job_title': 'Accountant' }, 'the branch was cut after the live edit');
    await store.put(T, 'demo-alice', { 'hr-attributes.language': 'fr' }, 'live', 'demo-alice'); // main moves after the cut
    await store.put(T, 'demo-alice', { 'hr-attributes.phone': '+33 6 12 34 56 78' }, 'work', 'admin');
    const r = await v.mergeInto(branch, 'main', 'Apply work-profile', 'demo-alice');
    assert.equal(r.mergeable, true, JSON.stringify(r));
    assert.deepEqual(await store.get(T, 'demo-bob', 'live'), { 'hr-attributes.employee_grade': 'G3' });
    assert.deepEqual(await store.get(T, 'demo-alice', 'live'), { 'hr-attributes.job_title': 'Accountant', 'hr-attributes.language': 'fr', 'hr-attributes.phone': '+33 6 12 34 56 78' });
    await store.put(T, 'demo-alice', { 'hr-attributes.phone': null }, 'live', 'demo-alice');
    assert.equal('hr-attributes.phone' in (await store.get(T, 'demo-alice', 'live')), false);
  });
});
