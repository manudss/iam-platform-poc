// Discard one change of a working branch, against a REAL Dolt SQL server (no Docker, no core).
// Auth is replaced by a fake that mirrors the real guard's contract (bearer token, tenant claim must equal :tenant), because the real one
// needs the Rust core; the real AdminGuard is used. Skipped with a clear message if the dolt binary is missing (set DOLT_BIN).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { VersioningModule } from './versioning.module.js';
import { VersioningController } from './versioning.controller.js';
import { VersioningService } from './versioning.service.js';
import { BranchProtectionService } from './branch-protection.service.js';
import { DoltService } from '../dolt/dolt.service.js';

const root = resolve(process.cwd(), '../..');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(doltBin);
const PORT = 13439, API = 'http://127.0.0.1:13440', ADMIN = 'test-admin-token-0123456789';

/** Same contract as the real guard: Bearer token "<tenant>:<sub>", tenant must match the route. */
class FakeAuth implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const h = String(req.headers['authorization'] ?? '');
    if (!h.startsWith('Bearer ')) throw new UnauthorizedException('missing bearer token');
    const [tenant, sub] = h.slice(7).split(':');
    if (!tenant || !sub) throw new UnauthorizedException('malformed token');
    if (req.params?.tenant !== undefined && req.params.tenant !== tenant) throw new ForbiddenException('wrong tenant');
    req.user = { tenant, sub };
    return true;
  }
}


describe('discard one change of a working branch + real Dolt', { skip: !have && 'dolt binary missing' }, () => {
  let dolt: ChildProcess, app: INestApplication, dir: string, v: VersioningService;
  const q = async (ref: string, sqlText: string) => { const c = await (v as any).connect(); try { await c.query('CALL DOLT_CHECKOUT(?)', [ref]); const [r] = await c.query(sqlText); return r as any[]; } finally { await c.end(); } };
  const commitOn = (b: string, text: string, msg: string) => v.writeOn(b, async (c) => { for (const t of text.split(';').filter((x) => x.trim())) await c.query(t); await c.query("CALL DOLT_ADD('-A')"); await c.query("CALL DOLT_COMMIT('-m', ?, '--author', 'T <t@example.invalid>')", [msg]); });
  const hash = async (b: string) => (await q('main', `select hashof('${b}') h`))[0].h as string;
  const cut = (n: string) => v.createBranch(n, 'main');
  const A = { id: 'demo-alice' };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-discard-'));
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
    Object.assign(process.env, { DOLT_PORT: String(PORT), DOLT_DATABASE: 'iam', IAM_API_ADMIN_TOKEN: ADMIN });
    process.env.IAM_VERSIONING_ALLOW_PROTECTED_WRITE = '1';
    const m = await Test.createTestingModule({ imports: [VersioningModule] }).overrideGuard(AuthGuard).useValue(new FakeAuth()).compile();
    app = m.createNestApplication(); await app.init(); await app.listen(13440);
    v = app.get(VersioningService);
    await commitOn('main', "alter table identities add column credential_revision varchar(40); update identities set credential_revision='rev0'; create table plugin_runtime_state (tenant varchar(32), plugin varchar(32), installed tinyint, enabled tinyint, faulted tinyint, primary key (tenant, plugin))", 'schema for the test');
    delete process.env.IAM_VERSIONING_ALLOW_PROTECTED_WRITE;
  });
  after(async () => { await app?.close(); dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });
  const withProtectionOff = async <T>(fn: () => Promise<T>) => { process.env.IAM_VERSIONING_ALLOW_PROTECTED_WRITE = '1'; try { return await fn(); } finally { delete process.env.IAM_VERSIONING_ALLOW_PROTECTED_WRITE; } };

  it('Alice case: dropping only the credential change removes the conflict and keeps the other changes', async () => {
    await cut('personal/alice');
    await commitOn('personal/alice', "update identities set department='Direction', credential_revision='revBRANCH' where id='demo-alice'; insert into roles values ('dev','Developer',false)", 'branch work');
    await withProtectionOff(() => commitOn('main', "update identities set credential_revision='revMAIN' where id='demo-alice'", 'published reset'));
    const before = await v.trialMerge('personal/alice', 'main');
    assert.equal(before.mergeable, false); assert.ok(before.conflicts >= 1, 'baseline: conflict');
    const head = await hash('personal/alice'), mainHead = await hash('main');
    const r = await v.discardChange('personal/alice', 'identities', A, { columns: ['credential_revision'], expectedHead: head }, 'tester');
    assert.equal(r.change, 'modified'); assert.match(r.action, /credential_revision/);
    const row = (await q('personal/alice', "select department, credential_revision from identities where id='demo-alice'"))[0];
    assert.equal(row.department, 'Direction'); assert.equal(row.credential_revision, 'rev0', 'back to the base value, not a new one');
    assert.equal((await q('personal/alice', "select count(*) n from roles where id='dev'"))[0].n, 1);
    assert.equal((await q('personal/alice', 'select count(*) n from dolt_status'))[0].n, 0);
    assert.equal(await hash('main'), mainHead, 'main untouched');
    assert.equal((await q('main', "select count(*) n from dolt_log('personal/alice..main')"))[0].n, 1, 'only main-only commits differ');
    const after = await v.trialMerge('personal/alice', 'main');
    assert.equal(after.conflicts, 0); assert.equal(after.mergeable, true, JSON.stringify(after.reasons));
    assert.equal(await hash('main'), mainHead, 'trial merge keeps nothing');
  });
  it('a stale head is refused and nothing changes', async () => {
    await cut('d-stale'); await commitOn('d-stale', "update identities set department='X' where id='demo-bob'", 'work');
    const h = await hash('d-stale');
    await assert.rejects(() => v.discardChange('d-stale', 'identities', { id: 'demo-bob' }, { expectedHead: 'f'.repeat(32) }, 't'), /Working branch changed/);
    assert.equal(await hash('d-stale'), h);
  });
  it('discarding a whole modified row, an added row and a removed row, one at a time', async () => {
    await cut('d-rows');
    await commitOn('d-rows', "update identities set department='Z', display_name='Zed' where id='demo-bob'; insert into roles values ('d-new','New',false); delete from roles where id='accountant'", 'three changes');
    const base = (await q('main', "select display_name, department from identities where id='demo-bob'"))[0];
    await v.discardChange('d-rows', 'identities', { id: 'demo-bob' }, { columns: ['department'] }, 't');
    let bob = (await q('d-rows', "select display_name, department from identities where id='demo-bob'"))[0];
    assert.equal(bob.display_name, 'Zed', 'other column of the same row kept'); assert.equal(bob.department, base.department);
    await v.discardChange('d-rows', 'identities', { id: 'demo-bob' }, {}, 't');
    bob = (await q('d-rows', "select display_name, department from identities where id='demo-bob'"))[0];
    assert.deepEqual(bob, base);
    await assert.rejects(() => v.discardChange('d-rows', 'identities', { id: 'demo-bob' }, {}, 't'), /no change/);
    await v.discardChange('d-rows', 'roles', { id: 'd-new' }, {}, 't');
    assert.equal((await q('d-rows', "select count(*) n from roles where id='d-new'"))[0].n, 0);
    await v.discardChange('d-rows', 'roles', { id: 'accountant' }, {}, 't');
    assert.equal((await q('d-rows', "select count(*) n from roles where id='accountant'"))[0].n, 1);
    assert.equal((await q('main', "select count(*) n from dolt_diff_summary('main...d-rows')"))[0].n, 0, 'branch back to no difference');
  });
  it('a branch-only plugin runtime row can be dropped, a new value still cannot be written', async () => {
    await cut('d-plug'); await commitOn('d-plug', "insert into plugin_runtime_state values ('acme','microsoft',1,0,0)", 'toggle');
    await assert.rejects(async () => v.editRows('d-plug', 'plugin_runtime_state', [{ op: 'update', key: { tenant: 'acme', plugin: 'microsoft' }, values: { enabled: 1 } }], undefined, 't'), /Plugins/);
    await v.discardChange('d-plug', 'plugin_runtime_state', { tenant: 'acme', plugin: 'microsoft' }, {}, 't');
    assert.equal((await q('d-plug', 'select count(*) n from plugin_runtime_state'))[0].n, 0);
    assert.equal((await q('main', "select count(*) n from dolt_diff_summary('main...d-plug')"))[0].n, 0);
  });
  it('refuses the target itself, a protected branch, a bad key, bad columns and an unchanged row', async () => {
    await assert.rejects(() => v.discardChange('main', 'identities', A, {}, 't'), /no changes of its own/);
    await cut('prot-x'); await commitOn('prot-x', "update identities set department='Q' where id='demo-bob'", 'w');
    process.env.IAM_PROTECTED_BRANCHES = 'main,prot-x';
    try { await assert.rejects(() => v.discardChange('prot-x', 'identities', { id: 'demo-bob' }, {}, 't'), /protected/); } finally { delete process.env.IAM_PROTECTED_BRANCHES; }
    await assert.rejects(() => v.discardChange('prot-x', 'identities', { id: 'demo-bob', department: 'x' }, {}, 't'), /primary key/);
    await assert.rejects(() => v.discardChange('prot-x', 'identities', { id: 'demo-bob' }, { columns: ['nope'] }, 't'), /existing columns/);
    await assert.rejects(() => v.discardChange('prot-x', 'identities', { id: 'demo-bob' }, { columns: ['id'] }, 't'), /key column/);
    await assert.rejects(() => v.discardChange('prot-x', 'identities', { id: 'demo-alice' }, {}, 't'), /no change/);
    await assert.rejects(() => v.discardChange('prot-x', 'identities; drop table roles', A, {}, 't'), /invalid table/);
    assert.equal((await q('prot-x', 'select count(*) n from dolt_status'))[0].n, 0);
  });
});
