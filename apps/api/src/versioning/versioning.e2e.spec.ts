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
import { DoltService } from '../dolt/dolt.service.js';

const root = resolve(process.cwd(), '../..');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(doltBin);
const PORT = 13417, API = 'http://127.0.0.1:13418', ADMIN = 'test-admin-token-0123456789';

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

describe('database explorer API + real Dolt', { skip: !have && 'dolt binary missing' }, () => {
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
    dir = mkdtempSync(join(tmpdir(), 'iam-vers-'));
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
    app = m.createNestApplication(); await app.init(); await app.listen(13418);
  });
  after(async () => { await app?.close(); dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  describe('access control', () => {
    it('every route has BOTH guards at controller level (no route can forget them)', () => {
      const guards: unknown[] = Reflect.getMetadata('__guards__', VersioningController) ?? [];
      const names = guards.map((g) => (g as { name: string }).name);
      assert.ok(names.includes('AuthGuard') && names.includes('AdminGuard'), `guards: ${names}`);
      const routes = Object.getOwnPropertyNames(VersioningController.prototype).filter((n) => n !== 'constructor' && Reflect.getMetadata('path', (VersioningController.prototype as any)[n]) !== undefined);
      assert.ok(routes.length >= 25, `route table walked: ${routes.length} routes`);
    });
    it('refuses without sign-in (401), with the wrong tenant (403), and without the admin capability (403), on reads and writes alike', async () => {
      const routes: [string, string, object?][] = [['GET', '/branches'], ['GET', '/log'], ['GET', '/tables'], ['GET', '/tables/assignments'], ['GET', '/pulls'], ['GET', '/tags'], ['GET', '/diff?from=main&to=main'], ['POST', '/sql', { sql: 'select 1' }],
        ['POST', '/branches', { name: 'x' }], ['POST', '/tables/assignments/edit', {}], ['POST', '/pulls', {}], ['DELETE', '/branches/x'], ['POST', '/branches/x/restore', {}]];
      for (const [m, p, b] of routes) {
        assert.equal((await call(m, p, b, { token: null })).status, 401, `${m} ${p} anonymous`);
        assert.equal((await call(m, p, b, { tenant: 'other', token: `${T}:demo-alice` })).status, 403, `${m} ${p} wrong tenant`);
        assert.equal((await call(m, p, b, { admin: null })).status, 403, `${m} ${p} no admin`);
        assert.equal((await call(m, p, b, { admin: 'wrong-wrong-wrong-wrong' })).status, 403, `${m} ${p} bad admin`);
      }
    });
    it('is disabled (403) when the admin token is not configured', async () => {
      const saved = process.env.IAM_API_ADMIN_TOKEN; delete process.env.IAM_API_ADMIN_TOKEN;
      try { assert.equal((await call('GET', '/branches', undefined, { admin: ADMIN })).status, 403); } finally { process.env.IAM_API_ADMIN_TOKEN = saved; }
    });
  });

  describe('branches, data, diff, history', () => {
    it('lists main, creates a branch, shows ahead/behind, rejects bad names', async () => {
      const b = await ok('GET', '/branches');
      assert.equal(b.default, 'main'); assert.ok(b.branches.find((x: any) => x.name === 'main').protected);
      await branchOf('feat-a');
      assert.equal((await call('POST', '/branches', { name: 'feat-a' })).status, 409);
      for (const n of ['a b', "x'; drop table roles; --", 'a/b', '', '..']) assert.equal((await call('POST', '/branches', { name: n })).status, 400, n);
      assert.equal((await call('POST', '/branches', { name: 'zz', from: 'nope' })).status, 404);
      assert.equal((await ok('GET', '/branches')).branches.find((x: any) => x.name === 'feat-a').aheadOfDefault, 0);
    });
    it('edits rows on a branch in ONE commit authored by the signed-in user; main refuses direct edits', async () => {
      const r = await ok('POST', '/tables/assignments/edit', { branch: 'feat-a', message: 'give alice accountant', ops: [{ op: 'insert', values: { identity_id: 'demo-alice', role_id: 'accountant' } }] });
      assert.match(r.commit, /^[0-9a-v]{32}$/);
      const log = await ok('GET', '/log?ref=feat-a&limit=5');
      assert.equal(log.commits[0].message, 'give alice accountant'); assert.equal(log.commits[0].author, 'demo-alice'); assert.equal(log.commits[0].parents.length, 1);
      assert.ok(log.commits[0].refs.includes('feat-a'));
      assert.equal(await count('feat-a', 'assignments'), 2); assert.equal(await count('main', 'assignments'), 1);
      const direct = await call('POST', '/tables/assignments/edit', { branch: 'main', ops: [{ op: 'delete', key: { identity_id: 'demo-bob', role_id: 'payment-creator' } }] });
      assert.equal(direct.status, 403); assert.equal(await count('main', 'assignments'), 1);
    });
    it('validates edits and leaves no half change behind', async () => {
      const bad = (ops: object[]) => call('POST', '/tables/assignments/edit', { branch: 'feat-a', ops });
      assert.equal((await bad([{ op: 'insert', values: { nope: 1 } }])).status, 400);
      assert.equal((await bad([{ op: 'update', key: { identity_id: 'x' }, values: { role_id: 'y' } }])).status, 400); // incomplete key
      assert.equal((await bad([{ op: 'delete', key: { identity_id: 'ghost', role_id: 'ghost' } }])).status, 404);
      assert.equal((await bad([{ op: 'insert', values: { identity_id: 'a', role_id: 'b' } }, { op: 'delete', key: { identity_id: 'ghost', role_id: 'ghost' } }])).status, 404); // second op fails: first is rolled back too
      assert.equal((await bad([{ op: 'frob' }])).status, 400);
      assert.equal((await call('POST', '/tables/dolt_log/edit', { branch: 'feat-a', ops: [{ op: 'insert', values: { x: 1 } }] })).status, 404);
      assert.equal((await call('POST', '/tables/x%3Bdrop/edit', { branch: 'feat-a', ops: [] })).status, 400);
      assert.equal(await count('feat-a', 'assignments'), 2);
      const st = await sql('feat-a', 'select * from dolt_status'); assert.equal(st.rows.length, 0, 'working set must be clean after failures');
      // and the next edit still works
      await ok('POST', '/tables/identities/edit', { branch: 'feat-a', ops: [{ op: 'update', key: { id: 'demo-bob' }, values: { department: 'treasury' } }] });
    });
    it('JSON columns can be edited from objects', async () => {
      await ok('POST', '/branches', { name: 'cfg', from: 'main' });
      await ok('POST', '/tables/plugin_config/edit', { branch: 'cfg', ops: [{ op: 'insert', values: { tenant: T, plugin: 'p1', enabled: true, settings: { limit: 3 } } }] });
      const rows = await ok('GET', '/tables/plugin_config?ref=cfg');
      assert.deepEqual(rows.rows[0].settings, { limit: 3 });
    });
    it('diffs two refs (two-dot and three-dot) at summary and row level', async () => {
      const d = await ok('GET', '/diff?from=main&to=feat-a&three=1');
      assert.deepEqual(d.tables.map((t: any) => [t.table, t.kind]).sort(), [['assignments', 'modified'], ['identities', 'modified']]);
      const rows = await ok('GET', '/diff/assignments?from=main&to=feat-a&three=1');
      assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].type, 'added'); assert.equal(rows.rows[0].to.role_id, 'accountant'); assert.equal(rows.rows[0].from, null);
      assert.deepEqual(rows.columns, ['identity_id', 'role_id']);
      const upd = await ok('GET', '/diff/identities?from=main&to=feat-a');
      assert.equal(upd.rows[0].type, 'modified'); assert.equal(upd.rows[0].from.department, 'finance'); assert.equal(upd.rows[0].to.department, 'treasury');
      assert.equal((await call('GET', '/diff?from=main&to=ghost')).status, 404);
      assert.equal((await call('GET', '/diff/x%3By?from=main&to=feat-a')).status, 400);
    });
    it('shows a commit with its changes and parents', async () => {
      const log = await ok('GET', '/log?ref=feat-a&limit=10');
      const c = await ok('GET', `/commits/${log.commits[1].commit}`);
      assert.equal(c.message, 'give alice accountant'); assert.equal(c.changes[0].table, 'assignments');
      assert.equal((await call('GET', '/commits/not-a-hash')).status, 400);
      assert.equal((await call('GET', `/commits/${'0'.repeat(32)}`)).status, 404);
    });
    it('reads tables at a branch, a commit and a tag (read only), with paging', async () => {
      const log = await ok('GET', '/log?ref=feat-a&limit=10');
      const before = log.commits[2].commit; // main's head at branch time
      assert.equal(await count(before, 'assignments'), 1);
      await ok('POST', '/tags', { name: 'v-seed', commit: before });
      assert.equal(await count('v-seed', 'assignments'), 1);
      const t = await ok('GET', '/tags'); assert.ok(t.tags.find((x: any) => x.name === 'v-seed'));
      assert.equal((await call('POST', '/tags', { name: 'act-x-1', commit: before })).status, 400);
      const page = await ok('GET', '/tables/assignments?ref=feat-a&limit=1&offset=0'); assert.equal(page.rows.length, 1); assert.equal(page.hasMore, true);
      assert.deepEqual(page.primaryKey, ['identity_id', 'role_id']); assert.match(page.createStatement, /CREATE TABLE/i);
      assert.equal((await call('GET', '/tables/dolt_log?ref=main')).status, 404);
      assert.equal((await call('GET', '/tables/assignments?ref=nope')).status, 404);
      await ok('DELETE', '/tags/v-seed');
      assert.equal((await call('DELETE', '/tags/act-1')).status, 403);
    });
    it('branch reads are isolated from each other, also when concurrent', async () => {
      const [a, b, c] = await Promise.all([count('feat-a', 'assignments'), count('main', 'assignments'), count('feat-a', 'assignments')]);
      assert.deepEqual([a, b, c], [2, 1, 2]);
    });
  });

  describe('SQL console', () => {
    it('reads on any ref, caps nothing silly, and refuses version-control and write statements', async () => {
      const r = await sql('feat-a', 'select identity_id, role_id from assignments order by 1,2'); assert.deepEqual(r.columns, ['identity_id', 'role_id']); assert.equal(r.rows.length, 2);
      assert.equal((await sql('main', 'select * from dolt_branches')).rows.length >= 2, true);
      assert.equal((await sql('main', 'show tables')).rows.length >= 5, true);
      for (const q of ["call dolt_commit('-am','x')", "select dolt_commit('-am','x')", "select dolt_merge('feat-a')", "insert into assignments values ('q','q')", 'drop table roles', 'select 1; select 2', 'select sleep(3)']) assert.equal((await call('POST', '/sql', { ref: 'main', sql: q })).status, 400, q);
      assert.equal(await count('main', 'assignments'), 1);
      assert.equal((await call('POST', '/sql', { ref: 'nope', sql: 'select 1' })).status, 404);
      assert.equal((await call('POST', '/sql', { ref: 'main', sql: 'selec 1' })).status, 400);
      assert.equal((await call('POST', '/sql', { ref: 'main', sql: 'select * from nope' })).status, 400);
    });
    it('write mode previews exactly, then commits on a branch; main is refused; destructive needs confirmation', async () => {
      await branchOf('sqlb');
      const prev = await ok('POST', '/sql', { mode: 'write', ref: 'sqlb', sql: "create table notes (id int primary key, t varchar(20)); insert into notes values (1,'a'),(2,'b');", dryRun: true });
      assert.equal(prev.committed, null); assert.equal(prev.dryRun, true); assert.equal(prev.changes[0].table, 'notes'); assert.equal(prev.changes[0].kind, 'added');
      assert.equal((await ok('GET', '/tables?ref=sqlb')).tables.some((t: any) => t.name === 'notes'), false, 'dry run keeps nothing');
      const run = await ok('POST', '/sql', { mode: 'write', ref: 'sqlb', sql: "create table notes (id int primary key, t varchar(20)); insert into notes values (1,'a'),(2,'b');", message: 'add notes' });
      assert.match(run.committed, /^[0-9a-v]{32}$/);
      assert.equal(await count('sqlb', 'notes'), 2);
      assert.equal((await ok('GET', '/log?ref=sqlb&limit=1')).commits[0].message, 'add notes');
      assert.equal((await call('POST', '/sql', { mode: 'write', ref: 'main', sql: "insert into roles values ('x','x',false)" })).status, 403);
      const del = await call('POST', '/sql', { mode: 'write', ref: 'sqlb', sql: 'delete from notes' });
      assert.equal(del.status, 409); assert.equal(del.body.code, 'destructive-confirmation-required'); assert.equal(await count('sqlb', 'notes'), 2);
      await ok('POST', '/sql', { mode: 'write', ref: 'sqlb', sql: 'delete from notes', confirmDestructive: true, message: 'clear notes' });
      assert.equal(await count('sqlb', 'notes'), 0);
      assert.equal((await call('POST', '/sql', { mode: 'write', ref: 'sqlb', sql: "insert into notes values (1,'a'); insert into nope values (1)" })).status, 400);
      assert.equal(await count('sqlb', 'notes'), 0, 'a failing statement rolls the whole run back');
      assert.equal((await sql('sqlb', 'select * from dolt_status')).rows.length, 0);
      const noop = await ok('POST', '/sql', { mode: 'write', ref: 'sqlb', sql: "update notes set t = 'z' where id = 99" });
      assert.equal(noop.committed, null);
      assert.equal((await call('POST', '/sql', { mode: 'write', ref: 'sqlb', sql: "call dolt_commit('-am','x')" })).status, 400);
      assert.equal((await call('POST', '/sql', { mode: 'write', ref: 'sqlb', sql: "drop table dolt_docs" })).status, 400);
    });
  });

  describe('pull requests', () => {
    let pr1: number;
    it('opens a pull request, shows commits, diff and passing checks; rejects duplicates and bad input', async () => {
      const r = await ok('POST', '/pulls', { title: 'Alice becomes accountant', body: 'why', source: 'feat-a', target: 'main' });
      pr1 = r.id; assert.equal(r.status, 'open'); assert.equal(r.author, 'demo-alice');
      assert.equal((await call('POST', '/pulls', { title: 'dup', source: 'feat-a', target: 'main' })).status, 409);
      assert.equal((await call('POST', '/pulls', { title: 'same', source: 'main', target: 'main' })).status, 400);
      assert.equal((await call('POST', '/pulls', { title: '', source: 'feat-a', target: 'main' })).status, 400);
      assert.equal((await call('POST', '/pulls', { title: 'x', source: 'ghost', target: 'main' })).status, 404);
      const g = await ok('GET', `/pulls/${pr1}`);
      assert.equal(g.checks.mergeable, true); assert.equal(g.commits.length, 2); assert.equal(g.diff.tables.length, 2);
      assert.equal((await sql('main', 'select * from dolt_status')).rows.length, 0, 'the trial merge left nothing behind');
      assert.equal((await call('GET', '/pulls/99999')).status, 404);
      assert.equal((await call('GET', '/pulls/abc')).status, 400);
      assert.equal((await call('GET', `/pulls/${pr1}`, undefined, { tenant: 'other', token: 'other:demo-alice' })).status, 404, 'a pull request is invisible to another tenant');
    });
    it('comments; an author cannot approve their own pull request', async () => {
      await ok('POST', `/pulls/${pr1}/comments`, { body: 'looks fine' });
      assert.equal((await call('POST', `/pulls/${pr1}/comments`, { kind: 'approve' })).status, 409);
      assert.equal((await call('POST', `/pulls/${pr1}/comments`, { body: '' })).status, 400);
      assert.equal((await ok('GET', `/pulls/${pr1}`)).comments.length, 1);
    });
    it('merges with a real merge commit; the data reaches main; a second merge is refused', async () => {
      const m = await ok('POST', `/pulls/${pr1}/merge`, {});
      assert.match(m.commit, /^[0-9a-v]{32}$/); assert.equal(m.pullRequest.status, 'merged');
      assert.equal(await count('main', 'assignments'), 2);
      const log = await ok('GET', '/log?ref=main&limit=3');
      assert.equal(log.commits[0].merge, true); assert.match(log.commits[0].message, /Merge pull request #\d+: Alice becomes accountant/);
      assert.equal((await call('POST', `/pulls/${pr1}/merge`, {})).status, 409);
      assert.equal((await call('POST', `/pulls/${pr1}/close`, {})).status, 409);
      assert.equal((await ok('GET', '/pulls?status=merged')).pullRequests.length, 1);
    });
    it('refuses a merge that would break Separation of Duties, and main stays unchanged and clean', async () => {
      await branchOf('sod');
      await ok('POST', '/tables/assignments/edit', { branch: 'sod', ops: [{ op: 'insert', values: { identity_id: 'demo-bob', role_id: 'payment-approver' } }] });
      const pr = await ok('POST', '/pulls', { title: 'bob approves too', source: 'sod', target: 'main' });
      const g = await ok('GET', `/pulls/${pr.id}`); assert.equal(g.checks.mergeable, false); assert.equal(g.checks.violations.length, 1);
      const before = (await ok('GET', '/log?ref=main&limit=1')).commits[0].commit;
      const m = await call('POST', `/pulls/${pr.id}/merge`, {});
      assert.equal(m.status, 409); assert.equal(m.body.code, 'merge-refused'); assert.match(m.body.message, /Separation-of-Duties/);
      assert.equal((await ok('GET', '/log?ref=main&limit=1')).commits[0].commit, before);
      assert.equal((await sql('main', 'select * from dolt_status')).rows.length, 0);
      assert.equal((await call('POST', `/pulls/${pr.id}/merge`, {})).status, 409);
      await ok('POST', `/pulls/${pr.id}/close`, {});
      assert.equal((await call('POST', `/pulls/${pr.id}/comments`, { body: 'late' })).status, 409);
    });
    it('detects data conflicts between two pull requests and refuses the second', async () => {
      await branchOf('c1'); await branchOf('c2');
      await ok('POST', '/tables/identities/edit', { branch: 'c1', ops: [{ op: 'update', key: { id: 'demo-alice' }, values: { display_name: 'Alice One' } }] });
      await ok('POST', '/tables/identities/edit', { branch: 'c2', ops: [{ op: 'update', key: { id: 'demo-alice' }, values: { display_name: 'Alice Two' } }] });
      const p1 = await ok('POST', '/pulls', { title: 'c1', source: 'c1', target: 'main' });
      const p2 = await ok('POST', '/pulls', { title: 'c2', source: 'c2', target: 'main' });
      await ok('POST', `/pulls/${p1.id}/merge`, {});
      const g = await ok('GET', `/pulls/${p2.id}`); assert.equal(g.checks.mergeable, false); assert.ok(g.checks.conflicts > 0);
      const m = await call('POST', `/pulls/${p2.id}/merge`, {}); assert.equal(m.status, 409);
      assert.equal((await sql('main', "select display_name from identities where id = 'demo-alice'")).rows[0].display_name, 'Alice One');
      assert.equal((await sql('main', 'select * from dolt_status')).rows.length, 0, 'conflicted merge fully aborted');
      assert.equal((await sql('main', 'select * from dolt_conflicts')).rows.length, 0);
    });
    it('can require approvals from someone other than the author', async () => {
      process.env.IAM_PR_APPROVALS = '1';
      try {
        await branchOf('appr'); await ok('POST', '/tables/roles/edit', { branch: 'appr', ops: [{ op: 'insert', values: { id: 'auditor', label: 'Auditor', is_sensitive: false } }] });
        const pr = await ok('POST', '/pulls', { title: 'auditor role', source: 'appr', target: 'main' });
        const refused = await call('POST', `/pulls/${pr.id}/merge`, {}); assert.equal(refused.status, 409); assert.equal(refused.body.code, 'approvals-required');
        await ok('POST', `/pulls/${pr.id}/comments`, { kind: 'approve' }, { token: `${T}:demo-bob` });
        assert.equal((await ok('POST', `/pulls/${pr.id}/merge`, {})).pullRequest.status, 'merged');
      } finally { delete process.env.IAM_PR_APPROVALS; }
    });
  });

  describe('revert, restore, delete', () => {
    it('reverts a commit onto a NEW branch (history kept, main untouched); direct revert on main is refused', async () => {
      const log = await ok('GET', '/log?ref=main&limit=30');
      const target = log.commits.find((c: any) => c.message === 'give alice accountant').commit;
      assert.equal((await call('POST', `/commits/${target}/revert`, { onto: 'main' })).status, 403);
      const before = log.commits[0].commit;
      const r = await ok('POST', `/commits/${target}/revert`, { newBranch: 'revert-alice', message: 'undo: alice accountant' });
      assert.equal(r.createdBranch, true);
      assert.equal(await count('revert-alice', 'assignments'), 1); assert.equal(await count('main', 'assignments'), 2);
      assert.equal((await ok('GET', '/log?ref=main&limit=1')).commits[0].commit, before);
      assert.equal((await ok('GET', '/log?ref=revert-alice&limit=1')).commits[0].message, 'undo: alice accountant');
      assert.equal((await call('POST', `/commits/${target}/revert`, {})).status, 400);
      assert.equal((await call('POST', `/commits/${target}/revert`, { newBranch: 'revert-alice' })).status, 409, 'branch exists');
    });
    it('restores an unprotected branch to an earlier commit only with confirmation; protected branches refuse', async () => {
      const log = await ok('GET', '/log?ref=feat-a&limit=10');
      const oldest = log.commits[2].commit, head = log.commits[0].commit;
      assert.equal((await call('POST', '/branches/feat-a/restore', { commit: oldest })).status, 409);
      assert.equal((await call('POST', '/branches/main/restore', { commit: oldest, confirm: true })).status, 403);
      assert.equal((await call('POST', '/branches/feat-a/restore', { commit: 'zz', confirm: true })).status, 404);
      const r = await ok('POST', '/branches/feat-a/restore', { commit: oldest, confirm: true });
      assert.equal(r.was, head); assert.equal(await count('feat-a', 'assignments'), 1);
      assert.equal((await ok('GET', '/log?ref=feat-a&limit=1')).commits[0].commit, oldest);
      assert.ok((await ok('GET', `/commits/${head}`)).message, 'the dropped commit still exists by hash');
    });
    it('deletes unprotected branches; refuses main and branches in an open pull request', async () => {
      assert.equal((await call('DELETE', '/branches/main')).status, 403);
      await branchOf('tmp-del'); await branchOf('tmp-pr');
      await ok('POST', '/tables/roles/edit', { branch: 'tmp-pr', ops: [{ op: 'insert', values: { id: 'zz', label: 'ZZ', is_sensitive: false } }] });
      const pr = await ok('POST', '/pulls', { title: 'tmp', source: 'tmp-pr', target: 'main' });
      assert.equal((await call('DELETE', '/branches/tmp-pr')).status, 409);
      await ok('POST', `/pulls/${pr.id}/close`, {});
      await ok('DELETE', '/branches/tmp-pr'); await ok('DELETE', '/branches/tmp-del');
      assert.equal((await call('DELETE', '/branches/ghost')).status, 404);
      assert.equal((await ok('GET', '/branches')).branches.some((b: any) => b.name === 'tmp-del'), false);
    });
    it('keeps the existing simulate/merge flow working next to the explorer', async () => {
      const dolt = new DoltService();
      const sim = await dolt.simulate('demo-alice', 'payment-creator');
      assert.ok(/^change-/.test(sim.branch));
      assert.ok((await ok('GET', '/branches')).branches.some((b: any) => b.name === sim.branch));
    });
  });
});
