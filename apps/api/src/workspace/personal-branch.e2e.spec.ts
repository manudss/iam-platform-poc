// Automatic personal branch, against a REAL Dolt SQL server (no Docker, no core). Skipped with a clear message if the dolt binary is missing (set DOLT_BIN).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { createConnection } from 'mysql2/promise';
import { VersioningModule } from '../versioning/versioning.module.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { PersonalBranchService } from './personal-branch.service.js';
import { WorkspaceController } from './workspace.controller.js';

const root = resolve(process.cwd(), '../..');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(doltBin);
const PORT = 13437;
const T = 'acme-demo';

describe('automatic personal branch + real Dolt', { skip: !have && 'dolt binary missing' }, () => {
  let dolt: ChildProcess, dir: string, v: VersioningService, p: PersonalBranchService, prs: PullRequestService;
  const names = async () => (await v.branches()).branches.map((b) => b.name).sort();
  const work = (branch: string, id: string) => v.editRows(branch, 'assignments', [{ op: 'insert', values: { identity_id: 'demo-alice', role_id: id } }], 'work ' + id, 'demo-alice');
  const seen = async (sub: string, minutesAgo: number) => {
    const c = await createConnection({ host: '127.0.0.1', port: PORT, user: 'root', database: 'iam_meta' });
    try { await c.query('update personal_branches set last_seen_at = NOW(3) - INTERVAL ? MINUTE where sub = ?', [minutesAgo, sub]); } finally { await c.end(); }
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-personal-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, val] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, val], { env });
    const seed = spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) });
    assert.equal(seed.status, 0, 'seed failed: ' + seed.stderr);
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', String(PORT), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', String(PORT), '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    Object.assign(process.env, { DOLT_PORT: String(PORT), DOLT_DATABASE: 'iam' });
    delete process.env.IAM_VERSIONING_ALLOW_PROTECTED_WRITE; delete process.env.IAM_WORKSPACE_MODE;
    const m = await Test.createTestingModule({ imports: [VersioningModule], providers: [PersonalBranchService] }).compile();
    v = m.get(VersioningService); prs = m.get(PullRequestService); p = m.get(PersonalBranchService);
  });
  after(async () => { dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('routes keep both controller guards (sign-in AND admin capability)', () => {
    const g = (Reflect.getMetadata('__guards__', WorkspaceController) ?? []).map((x: { name: string }) => x.name);
    assert.ok(g.includes('AuthGuard') && g.includes('AdminGuard'), String(g));
    for (const n of ['ensurePersonal', 'renamePersonal', 'releasePersonal']) assert.equal(Reflect.getMetadata('method', (WorkspaceController.prototype as any)[n]), 1, n + ' is POST');
  });

  it('creates a branch named after the user from main, and REUSES it on every later sign-in (no proliferation)', async () => {
    const a = await p.ensure(T, 'demo-alice');
    assert.deepEqual([a.branch, a.status, a.empty], ['personal/demo-alice', 'created', true]);
    const before = await names();
    for (let i = 0; i < 4; i++) assert.equal((await p.ensure(T, 'demo-alice')).status, 'reused');
    assert.deepEqual(await names(), before);
  });

  it('keeps work in progress: a branch with changes is reused untouched, never moved or released', async () => {
    await work('personal/demo-alice', 'wip-role');
    const head = (await v.branches()).branches.find((b) => b.name === 'personal/demo-alice')!.commit;
    const again = await p.ensure(T, 'demo-alice');
    assert.deepEqual([again.status, again.empty, again.aheadOfMain], ['reused', false, 1]);
    assert.deepEqual(await p.release(T, 'demo-alice'), { released: false, branch: 'personal/demo-alice', reason: 'has changes: kept' });
    assert.equal((await v.branches()).branches.find((b) => b.name === 'personal/demo-alice')!.commit, head);
  });

  it('an open pull request blocks rename and delete of the branch', async () => {
    const pr = await prs.create(T, { title: 'alice work', source: 'personal/demo-alice', target: 'main' }, 'demo-alice');
    await assert.rejects(p.rename(T, 'demo-alice', 'alice-renamed'), /open pull request/);
    await prs.close(T, (pr as any).id);
    assert.equal((await p.rename(T, 'demo-alice', 'alice-work')).was, 'personal/demo-alice');
    assert.ok((await names()).includes('personal/alice-work') && !(await names()).includes('personal/demo-alice'));
    assert.equal((await p.ensure(T, 'demo-alice')).branch, 'personal/alice-work', 'renamed branch is the one found again');
  });

  it('empty branch: released on sign-out, the (renamed) name is remembered and the next sign-in recreates it from main', async () => {
    const b = await p.ensure(T, 'demo-bob');
    assert.equal(b.status, 'created');
    assert.deepEqual(await p.release(T, 'demo-bob'), { released: true, branch: 'personal/demo-bob' });
    assert.ok(!(await names()).includes('personal/demo-bob'));
    assert.equal((await p.release(T, 'demo-bob')).released, false);
    assert.equal((await p.ensure(T, 'demo-bob')).status, 'recreated');
  });

  it('rename rules: own branch only, no protected or taken names, bad names rejected', async () => {
    await p.ensure(T, 'demo-bob'); // recreated
    // a renamed personal branch always keeps the personal/ folder, so it can never take a protected name.
    await assert.rejects(p.rename(T, 'demo-bob', 'alice-work'), /already exists/);
    for (const bad of ['a b', 'a/b', '', "x'; drop table roles; --", '..', 'x'.repeat(80)]) await assert.rejects(p.rename(T, 'demo-bob', bad), /invalid|Bad/i, bad);
    await assert.rejects(p.rename(T, 'nobody', 'zzz'), /no personal branch/);
    await assert.rejects(p.rename(T, '', 'zzz'), /signed-in/);
    assert.equal((await p.rename(T, 'demo-bob', 'personal/bob-sandbox')).branch, 'personal/bob-sandbox');
    await p.release(T, 'demo-bob');
    assert.equal((await p.ensure(T, 'demo-bob')).status, 'recreated');
    assert.deepEqual((await p.ensure(T, 'demo-bob')).branch, 'personal/bob-sandbox');
  });

  it('another user cannot take a reserved name, even while that branch is closed', async () => {
    await p.release(T, 'demo-bob');
    assert.ok(!(await names()).includes('personal/bob-sandbox'));
    await p.ensure(T, 'demo-carol');
    await assert.rejects(p.rename(T, 'demo-carol', 'bob-sandbox'), /reserved by another user/);
  });

  it('an empty branch that is behind main moves to main head; a branch with work is not touched', async () => {
    await p.ensure(T, 'demo-bob'); await p.release(T, 'demo-bob'); await p.ensure(T, 'demo-bob'); // empty
    process.env.IAM_VERSIONING_ALLOW_PROTECTED_WRITE = '1';
    try { await v.editRows('main', 'assignments', [{ op: 'insert', values: { identity_id: 'demo-bob', role_id: 'newer-main' } }], 'main moves on', 'demo-alice'); } finally { delete process.env.IAM_VERSIONING_ALLOW_PROTECTED_WRITE; }
    const r = await p.ensure(T, 'demo-bob');
    assert.deepEqual([r.status, r.behindMain, r.aheadOfMain], ['refreshed', 0, 0]);
    const alice = await p.ensure(T, 'demo-alice');
    assert.deepEqual([alice.status, alice.aheadOfMain, alice.behindMain], ['reused', 1, 1]);
  });

  it('sweep: other users idle EMPTY branches are deleted, idle branches with work are kept, active ones are kept', async () => {
    await p.ensure(T, 'demo-dave');
    await p.ensure(T, 'demo-erin');
    await work('personal/demo-erin', 'erin-wip');
    await seen('demo-dave', 500); await seen('demo-erin', 500);
    await p.ensure(T, 'demo-carol');
    const n = await names();
    assert.ok(!n.includes('personal/demo-dave'), 'idle empty branch swept');
    assert.ok(n.includes('personal/demo-erin'), 'idle branch with work kept');
    assert.ok(n.includes('personal/demo-carol'), 'caller kept');
    assert.equal((await p.ensure(T, 'demo-dave')).status, 'recreated');
  });
});
