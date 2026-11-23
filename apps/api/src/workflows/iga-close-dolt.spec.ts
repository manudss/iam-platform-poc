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
import { WorkflowsIgaService } from './iga.service.js';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'mysql2/promise';
// The ticket > account > sheet-row correlation on the REAL meta store (Dolt SQL server). Skipped when DOLT_BIN is missing (CI provides it).
const bin = process.env.DOLT_BIN ?? '', have = existsSync(bin);
const K = { tenant: 'tenant-a', connectionId: 'jira-demo', project: 'KAN', issueKey: 'KAN-7' };
const L = { ...K, account: 'bao', source: 'google', spreadsheetId: 'sheet-1', sheetId: 0, keyColumn: 'email', keyValue: 'bao@example.test', runId: 'run-p1' };
describe('IGA close and reentry on real Dolt', { skip: !have && 'DOLT_BIN missing' }, () => {
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
  async function campaign(id: string) {
    await store.igaPutCampaign({ id, tenant: 'acme', kind: 'user-access', name: 'Q4', ref: 'main', status: 'open', scope: {}, created_by: 'owner', created_at: '2026-11-23 00:00:00.000' }, []);
  }
  const service = (s: WorkflowStore) => new WorkflowsIgaService(s, undefined, { listAssignments: async () => ({ assignments: [] }) } as never);
  it('close commits to Dolt, fresh store parses the evidence, and the actual block resumes only its own close', async () => {
    await campaign('iga-resume');
    const out = await service(store).close('acme', 'workflow:run-own', 'iga-resume');
    const restarted = new WorkflowStore(new VersioningService());
    const persisted = await restarted.igaGetCampaign('acme', 'iga-resume');
    assert.equal(persisted!.closed_by, 'workflow:run-own');
    assert.deepEqual(persisted!.evidence, out.evidence);
    const evidence = persisted!.evidence as Record<string, unknown>;
    const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
    assert.equal(evidence.digestFormat, 'sha256-json-sorted-keys-v1');
    assert.equal(evidence.digest, createHash('sha256').update(canonical({ ...evidence, digest: null })).digest('hex'));
    const mod = await import(pathToFileURL(resolve('../../plugins/workflow-connectors/lyam-admin-blocks.mjs')).href);
    const block = mod.LYAM_ADMIN_BLOCKS.find((b: any) => b.type === 'iga-close-campaign');
    const iga = service(restarted);
    const ctx = { tenant: 'acme', runId: 'run-own', config: { campaignId: 'iga-resume' }, iga, log: () => {} };
    const resumed = await block.run(ctx);
    assert.equal(resumed.resumed, true);
    assert.deepEqual(resumed.evidence, evidence);
    await assert.rejects(() => block.run({ ...ctx, runId: 'run-other' }), /already closed/);
    assert.deepEqual((await restarted.igaGetCampaign('acme', 'iga-resume'))!.evidence, evidence);
  });
  it('concurrent closures have one winner; no run can overwrite the winner actor or evidence', async () => {
    await campaign('iga-race');
    const results = await Promise.allSettled(['run-a', 'run-b', 'run-c'].map((r) => service(store).close('acme', `workflow:${r}`, 'iga-race')));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    const persisted = await store.igaGetCampaign('acme', 'iga-race');
    assert.equal(persisted!.closed_by, `workflow:${['run-a', 'run-b', 'run-c'][winner]}`);
    const winningEvidence = (results[winner] as PromiseFulfilledResult<any>).value.evidence;
    assert.deepEqual(persisted!.evidence, winningEvidence);
    assert.equal(await store.igaCloseCampaign('iga-race', 'workflow:late', '2026-11-23 01:00:00.000', { forged: true }), false);
    assert.deepEqual((await store.igaGetCampaign('acme', 'iga-race'))!.evidence, winningEvidence);
  });
});
