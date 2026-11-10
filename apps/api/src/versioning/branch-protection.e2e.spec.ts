// End-to-end with a REAL Dolt SQL server (no Docker, no core): the database explorer API.
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
import { BranchProtectionService } from './branch-protection.service.js';
import { DoltService } from '../dolt/dolt.service.js';

const root = resolve(process.cwd(), '../..');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(doltBin);
const PORT = 13427, API = 'http://127.0.0.1:13428', ADMIN = 'test-admin-token-0123456789';

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

let decide: (i: { sub: string }) => Promise<{ allow: boolean; reasons: string[] }> = async (i) => ({ allow: i.sub === 'demo-alice', reasons: i.sub === 'demo-alice' ? ['merge-into-protected-needs-branch-merger'] : [] });

describe('branch protection and the merge policy + real Dolt', { skip: !have && 'dolt binary missing' }, () => {
  let dolt: ChildProcess, app: INestApplication, dir: string;
  const T = 'acme-demo';
  const call = async (method: string, path: string, body?: object, o: { token?: string | null; admin?: string | null; tenant?: string } = {}) => {
    const token = o.token === undefined ? `${o.tenant ?? T}:demo-alice` : o.token;
    const admin = o.admin === undefined ? ADMIN : o.admin;
    const r = await fetch(`${API}/tenants/${o.tenant ?? T}/versioning${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-api-admin-token': admin } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  };
  const ok = async (method: string, path: string, body?: object, o = {}) => { const r = await call(method, path, body, o); assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
  const sql = (ref: string, q: string) => ok('POST', '/sql', { ref, sql: q });
  const branchOf = async (name: string, from = 'main') => { await ok('POST', '/branches', { name, from }); return name; };
  const count = async (ref: string, table: string) => (await ok('GET', `/tables/${table}?ref=${ref}`)).total as number;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-prot-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, v], { env });
    const seed = spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) });
    assert.equal(seed.status, 0, 'seed failed: ' + seed.stderr);
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', String(PORT), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', String(PORT), '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    Object.assign(process.env, { DOLT_PORT: String(PORT), DOLT_DATABASE: 'iam', IAM_API_ADMIN_TOKEN: ADMIN });
    delete process.env.IAM_PR_APPROVALS; delete process.env.IAM_VERSIONING_ALLOW_PROTECTED_WRITE;
    const m = await Test.createTestingModule({ imports: [VersioningModule] }).overrideGuard(AuthGuard).useValue(new FakeAuth()).compile();
    app = m.createNestApplication(); await app.init(); await app.listen(13428);
    // This suite covers the Dolt mechanics, not the policy engine (no core here): the merge permission is covered by branch-protection.e2e.spec.ts.
    app.get(BranchProtectionService).decide = async (i) => decide(i);
  });
  after(async () => { await app?.close(); dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  const as = (sub: string) => ({ token: `${T}:${sub}` });
  const openPr = async (name: string, title: string, sub = 'demo-alice') => {
    await ok('POST', '/branches', { name, from: 'main' });
    await ok('POST', '/sql', { mode: 'write', ref: name, sql: `insert into roles values ('${name.slice(0, 20)}','${title}',false)`, message: title });
    return (await ok('POST', '/pulls', { title, source: name, target: 'main' }, as(sub))).id as number;
  };
  const mainHash = async () => (await sql('main', 'select hashof("main") h')).rows[0].h;

  it('main is protected by default and the setting is visible', async () => {
    const p = await ok('GET', '/protection');
    const main = p.protections.find((x: any) => x.branch === 'main');
    assert.deepEqual({ protected: main.protected, requirePullRequest: main.requirePullRequest, requireChecks: main.requireChecks, mergeRule: main.mergeRule, source: main.source }, { protected: true, requirePullRequest: true, requireChecks: true, mergeRule: 'policy', source: 'default' });
    assert.equal(p.policyAction, 'branch:merge');
  });
  it('a person without the policy cannot merge into main: 403 with a clear message, main unchanged; the PR page says so in advance', async () => {
    const id = await openPr('prot-a', 'A');
    const before = await mainHash();
    const view = await ok('GET', `/pulls/${id}`, undefined, as('demo-bob'));
    assert.equal(view.mayMerge.allowed, false); assert.match(view.mayMerge.message, /not allowed to merge into protected branch main/);
    const r = await call('POST', `/pulls/${id}/merge`, {}, as('demo-bob'));
    assert.equal(r.status, 403); assert.equal(r.body.code, 'merge-not-permitted'); assert.equal(r.body.action, 'branch:merge'); assert.match(r.body.message, /branch-merger/);
    assert.equal(await mainHash(), before); assert.equal((await ok('GET', `/pulls/${id}`)).pullRequest.status, 'open');
  });
  it('a person with the policy can merge', async () => {
    const id = await openPr('prot-b', 'B');
    assert.equal((await ok('GET', `/pulls/${id}`, undefined, as('demo-alice'))).mayMerge.allowed, true);
    const m = await ok('POST', `/pulls/${id}/merge`, {}, as('demo-alice'));
    assert.equal(m.pullRequest.status, 'merged');
  });
  it('fails closed when the policy engine cannot answer', async () => {
    const id = await openPr('prot-c', 'C'); const keep = decide;
    decide = async () => { throw new Error('core down'); };
    try { const r = await call('POST', `/pulls/${id}/merge`, {}, as('demo-alice')); assert.equal(r.status, 403); assert.deepEqual(r.body.reasons, ['policy-engine-unreachable']); } finally { decide = keep; }
  });
  it('an unprotected branch needs no policy', async () => {
    await ok('POST', '/branches', { name: 'free-target', from: 'main' });
    const id = await openPr('prot-d', 'D');
    await ok('DELETE', `/pulls/${id}`.replace('/pulls/', '/branches/prot-d-none')).catch(() => undefined);
    const pr = await ok('POST', '/pulls', { title: 'into free', source: 'prot-d', target: 'free-target' }, as('demo-bob'));
    const m = await ok('POST', `/pulls/${pr.id}/merge`, {}, as('demo-bob'));
    assert.equal(m.pullRequest.status, 'merged');
  });
  it('minimum reviews: the author does not count, someone else does', async () => {
    await ok('PUT', '/branches/main/protection', { minReviews: 1 }, as('demo-alice'));
    const id = await openPr('prot-e', 'E');
    assert.equal((await call('POST', `/pulls/${id}/comments`, { kind: 'approve' }, as('demo-alice'))).status, 409);
    const refused = await call('POST', `/pulls/${id}/merge`, {}, as('demo-alice'));
    assert.equal(refused.status, 409); assert.equal(refused.body.code, 'approvals-required');
    await ok('POST', `/pulls/${id}/comments`, { kind: 'approve' }, as('demo-bob'));
    assert.equal((await ok('POST', `/pulls/${id}/merge`, {}, as('demo-alice'))).pullRequest.status, 'merged');
    await ok('PUT', '/branches/main/protection', { minReviews: 0 }, as('demo-alice'));
  });
  it('changing protection is guarded by the same policy and validated', async () => {
    assert.equal((await call('PUT', '/branches/main/protection', { protected: false }, as('demo-bob'))).status, 403);
    assert.equal((await call('PUT', '/branches/main/protection', { mergeRule: 'anyone' }, as('demo-bob'))).status, 403);
    assert.equal((await call('PUT', '/branches/main/protection', { minReviews: -1 }, as('demo-alice'))).status, 400);
    assert.equal((await call('PUT', '/branches/main/protection', { mergeRule: 'nobody' }, as('demo-alice'))).status, 400);
    assert.equal((await call('PUT', '/branches/ghost/protection', { protected: true }, as('demo-alice'))).status, 400);
  });
  it('"anyone" rule: set by someone with the policy, then everyone may merge; back to policy restores the check', async () => {
    await ok('PUT', '/branches/main/protection', { mergeRule: 'anyone' }, as('demo-alice'));
    const id = await openPr('prot-f', 'F');
    assert.equal((await ok('POST', `/pulls/${id}/merge`, {}, as('demo-bob'))).pullRequest.status, 'merged');
    await ok('PUT', '/branches/main/protection', { mergeRule: 'policy' }, as('demo-bob')); // raising is allowed for anyone
    const id2 = await openPr('prot-g', 'G');
    assert.equal((await call('POST', `/pulls/${id2}/merge`, {}, as('demo-bob'))).status, 403);
  });
  it('a stored setting survives and direct writes to a protected branch stay refused', async () => {
    assert.equal((await ok('GET', '/protection')).protections.find((x: any) => x.branch === 'main').source, 'custom');
    assert.equal((await call('POST', '/sql', { mode: 'write', ref: 'main', sql: "insert into roles values ('z','z',false)" })).status, 403);
  });
  it('branch names may carry a folder (feature/x): create, protect, read, delete', async () => {
    await ok('POST', '/branches', { name: 'feature/slash-demo', from: 'main' });
    const p = await ok('PUT', '/branches/feature%2Fslash-demo/protection', { protected: true }, as('demo-alice'));
    assert.equal(p.branch, 'feature/slash-demo'); assert.equal(p.protected, true);
    assert.equal((await sql('feature/slash-demo', 'select count(*) n from roles')).rows.length, 1);
    await ok('PUT', '/branches/feature%2Fslash-demo/protection', { protected: false }, as('demo-alice'));
    await ok('DELETE', '/branches/feature%2Fslash-demo');
    assert.equal((await call('POST', '/branches', { name: 'a/b/c', from: 'main' })).status, 400);
  });
});
