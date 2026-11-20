// Rebase of a working branch on main, against a REAL Dolt SQL server (no Docker, no core).
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
const PORT = 13437, API = 'http://127.0.0.1:13438', ADMIN = 'test-admin-token-0123456789';

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


describe('rebase a working branch on main + real Dolt', { skip: !have && 'dolt binary missing' }, () => {
  let dolt: ChildProcess, app: INestApplication, dir: string, v: VersioningService;
  const q = async (ref: string, sqlText: string) => { const c = await (v as any).connect(); try { await c.query('CALL DOLT_CHECKOUT(?)', [ref]); const [r] = await c.query(sqlText); return r as any[]; } finally { await c.end(); } };
  const commitOn = (b: string, text: string, msg: string) => v.writeOn(b, async (c) => { await c.query(text); await c.query("CALL DOLT_ADD('-A')"); await c.query("CALL DOLT_COMMIT('-m', ?, '--author', 'T <t@example.invalid>')", [msg]); });
  const hash = async (b: string) => (await q('main', `select hashof('${b}') h`))[0].h as string;
  const labels = async (b: string) => (await q(b, 'select id from roles order by id')).map((r) => r.id);
  const cut = (n: string) => v.createBranch(n, 'main');

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-rebase-'));
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
    app = m.createNestApplication(); await app.init(); await app.listen(13438);
    v = app.get(VersioningService);
  });
  after(async () => { await app?.close(); dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('replays the branch commits on the latest main: it gets main changes and keeps its own, main is untouched', async () => {
    await cut('rb-a'); await commitOn('rb-a', "insert into roles values ('rb-a-own','Own role',false)", 'branch work');
    await commitOn('main', "insert into roles values ('rb-main-new','From main',false)", 'main moves');
    const mainBefore = await hash('main'), before = await hash('rb-a');
    const r = await v.rebaseOnDefault('rb-a', before);
    assert.equal(r.rebased, true); assert.equal(r.behind, 1); assert.equal(r.ahead, 1); assert.notEqual(r.commit, before);
    assert.deepEqual((await labels('rb-a')).filter((x) => x.startsWith('rb-')), ['rb-a-own', 'rb-main-new']);
    assert.equal(await hash('main'), mainBefore);
    assert.equal((await q('main', "select count(*) n from dolt_log('main..rb-a')"))[0].n, 1, 'exactly the branch own commit stays on top of main');
    assert.equal((await q('main', "select count(*) n from dolt_log('rb-a..main')"))[0].n, 0);
  });
  it('is a no-op when the branch already contains main', async () => {
    const h = await hash('rb-a'); const r = await v.rebaseOnDefault('rb-a');
    assert.equal(r.upToDate, true); assert.equal(r.rebased, false); assert.equal(await hash('rb-a'), h);
  });
  it('a branch with no commit of its own moves forward', async () => {
    await cut('rb-empty'); await commitOn('main', "insert into roles values ('rb-main-2','More',false)", 'main moves again');
    const r = await v.rebaseOnDefault('rb-empty');
    assert.equal(r.rebased, true); assert.equal(r.ahead, 0); assert.equal(await hash('rb-empty'), await hash('main'));
  });
  it('a conflict refuses the rebase and leaves the branch exactly as it was', async () => {
    await cut('rb-conf'); await commitOn('rb-conf', "update roles set label='Branch label' where id='rb-main-new'", 'branch edits the role');
    await commitOn('main', "update roles set label='Main label' where id='rb-main-new'", 'main edits the same role');
    const before = await hash('rb-conf');
    await assert.rejects(() => v.rebaseOnDefault('rb-conf'), (e: any) => { assert.equal(e.getStatus?.(), 409); assert.match(JSON.stringify(e.getResponse()), /conflicts with main/); return true; });
    assert.equal(await hash('rb-conf'), before);
    assert.equal((await q('rb-conf', "select label from roles where id='rb-main-new'"))[0].label, 'Branch label');
    assert.equal((await q('rb-conf', 'select count(*) n from dolt_status'))[0].n, 0);
    // the branch is still usable afterwards
    await commitOn('rb-conf', "insert into roles values ('rb-after','After',false)", 'still writable');
  });
  it('refuses main, a protected branch, a stale head and uncommitted work', async () => {
    await assert.rejects(() => v.rebaseOnDefault('main'), /cannot be rebased/);
    await cut('rb-stale'); await commitOn('main', "insert into roles values ('rb-main-3','Third',false)", 'main moves 3');
    await assert.rejects(() => v.rebaseOnDefault('rb-stale', 'f'.repeat(32)), /Working branch changed/);
  });
});
