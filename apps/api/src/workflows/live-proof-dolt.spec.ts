import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VersioningService } from '../versioning/versioning.service.js';
import { WorkspacePublisher } from '../workspace/workspace-publisher.js';
// WorkspacePublisher.liveProof on a REAL Dolt: the read-back a secret mail waits for (main really contains the head this run published). Skipped when DOLT_BIN is missing (CI provides it).
const bin = process.env.DOLT_BIN ?? '', have = existsSync(bin);
describe('liveProof on real Dolt', { skip: !have && 'DOLT_BIN missing' }, () => {
  let dir: string, proc: ChildProcess, v: VersioningService, pub: WorkspacePublisher;
  const saved: Record<string, string | undefined> = {};
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wf-proof-')); const home = join(dir, 'h'), data = join(dir, 'd'); mkdirSync(home); mkdirSync(data); const env = { ...process.env, HOME: home };
    for (const [k, v2] of [['user.name', 'test'], ['user.email', 'test@example.invalid'], ['metrics.disabled', 'true']]) assert.equal(spawnSync(bin, ['config', '--global', '--add', k, v2], { env }).status, 0);
    assert.equal(spawnSync(bin, ['sql'], { cwd: data, env, input: readFileSync(resolve('../../data/demo/01-schema.sql')) }).status, 0);
    proc = spawn(bin, ['sql-server', '--host', '127.0.0.1', '--port', '14379', '--data-dir', data], { env, cwd: data, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if (spawnSync(bin, ['--host', '127.0.0.1', '--port', '14379', '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await new Promise((r) => setTimeout(r, 200)); }
    for (const k of ['DOLT_PORT', 'DOLT_DATABASE']) saved[k] = process.env[k]; Object.assign(process.env, { DOLT_PORT: '14379', DOLT_DATABASE: 'iam' });
    v = new VersioningService();
    pub = Object.create(WorkspacePublisher.prototype) as WorkspacePublisher;
    Object.assign(pub as object, { v, activation: { current: async () => ({ state: 'applied', commit: 'c0ffee00' }) } });
  });
  after(async () => { proc?.kill(); await new Promise((r) => setTimeout(r, 500)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  it('reports containsHead false until the run head is really merged into main, then true; an unknown or malformed head is refused (the mail then fails closed)', async () => {
    await v.createBranch('wf-proof', 'main');
    const head = await v.at('wf-proof', async (c) => {
      await c.query("insert into dolt_ignore values ('zz_proof_%', true)").catch(() => undefined);
      await c.query('create table proof_marker (id int primary key)'); await c.query('insert into proof_marker values (1)');
      await c.query("call dolt_add('proof_marker')"); await c.query("call dolt_commit('-m','proof marker')");
      return String(((await c.query("select commit_hash h from dolt_log limit 1"))[0] as { h: string }[])[0].h);
    });
    const before = await pub.liveProof('tenant-a', head);
    assert.equal(before.containsHead, false, 'not on main yet');
    assert.equal(before.activation, 'applied');
    await v.at('main', async (c) => { await c.query("call dolt_merge('wf-proof')"); });
    const mainNow = (await v.branches()).branches.find((b) => b.name === 'main')!.commit;
    const after = await pub.liveProof('tenant-a', head);
    assert.equal(after.containsHead, true, 'merged into main');
    assert.equal(after.mainCommit, mainNow);
    await assert.rejects(() => pub.liveProof('tenant-a', 'not a hash'), /sourceHead/);
    await assert.rejects(() => pub.liveProof('tenant-a', 'deadbeefdeadbeefdeadbeef'));
  });
});
