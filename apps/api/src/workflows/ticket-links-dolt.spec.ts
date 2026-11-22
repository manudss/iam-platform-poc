import { localTestPort } from '../testing/local-test-port.js';
import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VersioningService } from '../versioning/versioning.service.js';
import { WorkflowStore } from './store.js';
import { createConnection } from 'mysql2/promise';
// The ticket > account > sheet-row correlation on the REAL meta store (Dolt SQL server). Skipped when DOLT_BIN is missing (CI provides it).
const bin = process.env.DOLT_BIN ?? '', have = existsSync(bin);
const K = { tenant: 'tenant-a', connectionId: 'jira-demo', project: 'KAN', issueKey: 'KAN-7' };
const L = { ...K, account: 'bao', source: 'google', spreadsheetId: 'sheet-1', sheetId: 0, keyColumn: 'email', keyValue: 'bao@example.test', runId: 'run-p1' };
describe('ticket links on real Dolt', { skip: !have && 'DOLT_BIN missing' }, () => {
  let dir: string, proc: ChildProcess, store: WorkflowStore;
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
    store = new WorkflowStore(new VersioningService());
  });
  after(async () => { proc?.kill(); await new Promise((r) => setTimeout(r, 500)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  it('records once; the same content again is an idempotent retry; another account or row for the same ticket is refused and nothing is overwritten', async () => {
    const a = await store.putTicketLink(L); assert.equal(a.status, 'open'); assert.equal(a.account, 'bao');
    await store.putTicketLink(L);
    await assert.rejects(() => store.putTicketLink({ ...L, account: 'mallory' }), /conflict/);
    await assert.rejects(() => store.putTicketLink({ ...L, keyValue: 'other@example.test' }), /conflict/);
    assert.equal((await store.getTicketLink(K))!.account, 'bao');
  });
  it('is keyed by tenant, connection, project and key: another tenant, connection or project sees nothing', async () => {
    for (const other of [{ ...K, tenant: 'tenant-b' }, { ...K, connectionId: 'jira-other' }, { ...K, project: 'ABC' }, { ...K, issueKey: 'KAN-8' }]) assert.equal(await store.getTicketLink(other), null);
    assert.equal(await store.claimTicketLink({ ...K, tenant: 'tenant-b' }, 'run-x'), null);
  });
  it('claim is atomic and single-run: the first run gets it (and again on its own resume), any other run and a done link get nothing', async () => {
    const results = await Promise.all(['run-a', 'run-b', 'run-c'].map((r) => store.claimTicketLink(K, r)));
    assert.equal(results.filter(Boolean).length, 1, 'exactly one concurrent claim wins');
    const winner = ['run-a', 'run-b', 'run-c'][results.findIndex(Boolean)];
    assert.ok(await store.claimTicketLink(K, winner), 'the owner can resume');
    for (const r of ['run-a', 'run-b', 'run-c'].filter((x) => x !== winner)) assert.equal(await store.claimTicketLink(K, r), null);
    assert.equal(await store.completeTicketLink(K, 'run-other'), false);
    assert.equal(await store.completeTicketLink(K, winner), true);
    assert.equal((await store.getTicketLink(K))!.status, 'done');
    assert.equal(await store.claimTicketLink(K, winner), null, 'a done link is never claimed again');
    assert.equal(await store.completeTicketLink(K, winner), false);
  });
  // The deploy qualification hashes the WORKING root of every Dolt database (iam_meta included) before and after a restart on the new image:
  // any boot-time schema change of a database written by the previous release is a "transformation" that stops the rollout without a per-digest verifier.
  it('a restart on a database written by the previous release (no ticket-link table) does not change iam_meta; the table appears only on first use', async () => {
    const root = async () => { const c = await createConnection({ host: '127.0.0.1', port, user: 'root', password: '', database: 'iam_meta' }); try { const [r] = await c.query("SELECT DOLT_HASHOF_DB('WORKING') AS h"); return (r as { h: string }[])[0].h; } finally { await c.end(); } };
    const hasTable = async () => { const c = await createConnection({ host: '127.0.0.1', port, user: 'root', password: '', database: 'iam_meta' }); try { const [r] = await c.query("show tables like 'workflow_ticket_links'"); return (r as unknown[]).length > 0; } finally { await c.end(); } };
    const c0 = await createConnection({ host: '127.0.0.1', port, user: 'root', password: '', database: 'iam_meta' });
    try { await c0.query('drop table if exists workflow_ticket_links'); } finally { await c0.end(); }   // the previous release never had it
    assert.equal(await hasTable(), false);
    const before = await root();
    const restarted = new WorkflowStore(new VersioningService());
    await restarted.prepareMigrationStorage();            // what a boot does
    assert.equal(await restarted.getTicketLink({ ...K, issueKey: 'KAN-404' }) === null, true);   // reading the empty store at boot-time use creates nothing visible to the qualification
    assert.equal(await root(), before, 'boot and a read of a missing link leave the preserved state byte-identical');
    assert.equal(await hasTable(), false, 'no table was created by boot or by a read');
    assert.equal(await restarted.claimTicketLink({ ...K, issueKey: 'KAN-404' }, 'run-x'), null, 'claim on a never-written store: no link');
    assert.equal(await restarted.completeTicketLink({ ...K, issueKey: 'KAN-404' }, 'run-x'), false);
    assert.equal(await root(), before, 'claim and complete without a link change nothing either');
    assert.equal(await hasTable(), false);
    await restarted.putTicketLink({ ...L, issueKey: 'KAN-9' });
    assert.equal(await hasTable(), true, 'first write creates it (normal operational use, after the qualification window)');
    assert.equal((await restarted.getTicketLink({ ...K, issueKey: 'KAN-9' }))!.account, 'bao');
  });
});
