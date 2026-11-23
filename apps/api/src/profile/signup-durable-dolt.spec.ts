import { localTestPort } from '../testing/local-test-port.js';
import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VersioningService } from '../versioning/versioning.service.js';
import { DoltSignupRequestStore } from './signup-request-store.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { createConnection } from 'mysql2/promise';
// The ticket > account > sheet-row correlation on the REAL meta store (Dolt SQL server). Skipped when DOLT_BIN is missing (CI provides it).
const bin = process.env.DOLT_BIN ?? '', have = existsSync(bin);
const K = { tenant: 'tenant-a', connectionId: 'jira-demo', project: 'KAN', issueKey: 'KAN-7' };
const L = { ...K, account: 'bao', source: 'google', spreadsheetId: 'sheet-1', sheetId: 0, keyColumn: 'email', keyValue: 'bao@example.test', runId: 'run-p1' };
describe('signup queue on real Dolt', { skip: !have && 'DOLT_BIN missing' }, () => {
  let dir: string, proc: ChildProcess, store: DoltSignupRequestStore;
  let port: number;
  const saved: Record<string, string | undefined> = {};
  before(async () => {
    port = await localTestPort();
    dir = mkdtempSync(join(tmpdir(), 'wf-links-')); const home = join(dir, 'h'), data = join(dir, 'd'); mkdirSync(home); mkdirSync(data); const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'test'], ['user.email', 'test@example.invalid']]) assert.equal(spawnSync(bin, ['config', '--global', '--add', k, v], { env }).status, 0);
    assert.equal(spawnSync(bin, ['sql'], { cwd: data, env, input: readFileSync(resolve('../../data/demo/01-schema.sql')) }).status, 0);
    proc = spawn(bin, ['sql-server', '--host', '127.0.0.1', '--port', String(port), '--data-dir', data], { env, cwd: data, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '', lastProbe = '';
    for (const stream of [proc.stdout, proc.stderr]) stream?.on('data', data => { diagnostic = (diagnostic + data).slice(-4000); });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      assert.equal(proc.exitCode, null, 'the fixture Dolt server exited before readiness');
      try {
        const probe = await createConnection({ host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 500 });
        try { await probe.query('select 1'); } finally { await probe.end(); }
        ready = true; break;
      } catch (error) { lastProbe = String(error); }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(ready, true, 'the fixture Dolt server never became ready: ' + diagnostic + lastProbe);
    for (const k of ['DOLT_PORT', 'DOLT_DATABASE']) saved[k] = process.env[k]; Object.assign(process.env, { DOLT_PORT: String(port), DOLT_DATABASE: 'iam' });
    store = new DoltSignupRequestStore();
  });
  after(async () => { proc?.kill(); await new Promise((r) => setTimeout(r, 500)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  it('a missing queue read changes no storage, confirmed queue survives new store and stale CAS cannot restore a deleted request', async () => {
    const c = await createConnection({ host: '127.0.0.1', port, user: 'root', database: 'iam' });
    try {
      await c.query('create database if not exists iam_meta'); await c.query('use iam_meta');
      const hash = async () => { const [r] = await c.query("select dolt_hashof_db('WORKING') h"); return (r as any[])[0].h; };
      const before = await hash();
      assert.deepEqual(await store.load('acme'), { revision: 0, requests: [] });
      assert.equal(await hash(), before);
    } finally { await c.end(); }
    const { createSignupManager } = loadPluginModule('directory', 'signup.mjs') as any;
    let token = '';
    const manager = () => createSignupManager({
      pendingLoad: (t: string) => new DoltSignupRequestStore().load(t),
      pendingSave: (t: string, rev: number, rows: any[]) => new DoltSignupRequestStore().save(t, rev, rows),
      signupOpen: async () => true, signupValues: async () => ({}), usersList: async () => [], currentBranch: () => undefined, emit: () => {},
      outboxSend: async (m: any) => { token = m.text.split(': ')[1]; },
    });
    await manager().submit('acme', { id: 'fiction', display_name: 'Fiction', email: 'fiction@example.invalid', password: 'fictional-password-123', values: {} }, 'ip');
    await manager().confirm('acme', token);
    const reloaded = await manager().list('acme');
    assert.equal(reloaded.requests[0].confirmed, true);
    assert.doesNotMatch(JSON.stringify(reloaded), /hash|salt|token|password/i);
    const snapshot = await store.load('acme');
    await manager().reject('fiction', 'acme');
    await assert.rejects(store.save('acme', snapshot.revision, snapshot.requests), /changed/);
    assert.deepEqual((await new DoltSignupRequestStore().load('acme')).requests, []);
  });
});
