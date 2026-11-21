import 'reflect-metadata';
import '../authn/flow.service.js';   // load order: enter the cyclic module graph from the sign-in flow, as the app does
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VersioningService } from '../versioning/versioning.service.js';
import { UsersService } from './users.service.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { WorkflowEngine } from '../workflows/engine.js';
import { BlockStore } from '../accounts/block-store.js';
import { canSignIn } from '../accounts/blocks.js';
// UsersService temporary password, first access and credential revision on a REAL Dolt, with a credential file in a temp dir. Fictional accounts only. Skipped when DOLT_BIN is missing (CI provides it).
const bin = process.env.DOLT_BIN ?? '', have = existsSync(bin);
const TEMP = 'Temp-Pass-Fictional-1', NEXT = 'Next-Pass-Fictional-2', SEED = 'Seed-Pass-Fictional-0';
describe('UsersService temporary password on real Dolt', { skip: !have && 'DOLT_BIN missing' }, () => {
  let dir: string, proc: ChildProcess, v: VersioningService, svc: UsersService, credFile: string;
  const saved: Record<string, string | undefined> = {};
  const rev = async (id: string) => String((await svc.list('main')).find((x) => x.id === id)?.credential_revision);
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'users-tmp-')); const home = join(dir, 'h'), data = join(dir, 'd'); mkdirSync(home); mkdirSync(data); const env = { ...process.env, HOME: home };
    for (const [k, v2] of [['user.name', 'test'], ['user.email', 'test@example.invalid'], ['metrics.disabled', 'true']]) assert.equal(spawnSync(bin, ['config', '--global', '--add', k, v2], { env }).status, 0);
    assert.equal(spawnSync(bin, ['sql'], { cwd: data, env, input: readFileSync(resolve('../../data/demo/01-schema.sql')) }).status, 0);
    proc = spawn(bin, ['sql-server', '--host', '127.0.0.1', '--port', '14380', '--data-dir', data], { env, cwd: data, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if (spawnSync(bin, ['--host', '127.0.0.1', '--port', '14380', '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await new Promise((r) => setTimeout(r, 100)); }
    credFile = join(dir, 'creds', 'credentials.json');
    for (const k of ['DOLT_PORT', 'DOLT_DATABASE', 'IAM_CREDENTIAL_FILE', 'IAM_DIRECTORY_AUTH', 'IAM_WORKSPACE_MODE', 'IAM_DATA_MIGRATIONS']) saved[k] = process.env[k];
    Object.assign(process.env, { DOLT_PORT: '14380', DOLT_DATABASE: 'iam', IAM_CREDENTIAL_FILE: credFile, IAM_DIRECTORY_AUTH: '1' }); delete process.env.IAM_WORKSPACE_MODE; delete process.env.IAM_DATA_MIGRATIONS;
    v = new VersioningService();
    const registry = { resolve: () => { throw new Error('no policy plugin in this spec'); }, isActive: () => false, callSlot: async () => ({ result: { valid: true } }) };
    const modules = { get: (t: unknown) => (t === BranchRegistries ? { get: () => registry } : t === PluginRegistry ? registry : undefined) };
    svc = new UsersService(v, modules as never);
    await svc.seedAccount({ id: 'fict-a', display_name: 'Fictional A', department: 'IT', manager_id: null, email: 'a@example.invalid' }, SEED);
    await svc.seedAccount({ id: 'fict-admin', display_name: 'Fictional Admin', department: 'IT', manager_id: null, email: 'admin@example.invalid' }, SEED);
  });
  after(async () => { proc?.kill(); await new Promise((r) => setTimeout(r, 500)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  it('temporary password: new revision, flag and expiry bound to it, old password dead on main, nothing in clear in Dolt or the credential file', async () => {
    const before_ = await rev('fict-a');
    assert.equal(await svc.authenticate('acme-demo', 'fict-a', SEED), true);
    const r = await svc.setTemporaryPassword('acme-demo', 'fict-admin', 'fict-a', TEMP, 2);
    assert.equal(r.mustChange, true); assert.equal(r.ref, 'main'); assert.equal(r.pendingPublication, false);
    const after_ = await rev('fict-a'); assert.notEqual(after_, before_);
    const st = await svc.firstAccessState('acme-demo', 'fict-a'); assert.equal(st.required, true);
    assert.equal(st.required && st.revision, after_); assert.equal(st.required && st.expired, false);
    assert.equal(await svc.authenticate('acme-demo', 'fict-a', TEMP), true);
    assert.equal(await svc.authenticate('acme-demo', 'fict-a', SEED), false);
    const file = readFileSync(credFile, 'utf8'); for (const p of [TEMP, SEED, NEXT]) assert.equal(file.includes(p), false);
    await v.at('main', async (c) => { const [rows] = await c.query('select * from identities'); const s = JSON.stringify(rows); for (const p of [TEMP, SEED]) assert.equal(s.includes(p), false); const [dirty] = await c.query('select * from dolt_status'); assert.deepEqual(dirty, []); });
    // an administrator never sets a temporary password on their own account
    await assert.rejects(() => svc.setTemporaryPassword('acme-demo', 'fict-a', 'fict-a', TEMP + 'x', 2), /own account/);
    assert.equal(await rev('fict-a'), after_);
  });
  it('first access: the proven revision binds the change; a reset in between, the same password, expiry and a short password are refused; the winner consumes the flag', async () => {
    const proven = await rev('fict-a');
    assert.deepEqual(await svc.completeFirstAccess('acme-demo', 'fict-a', TEMP, proven), { ok: false, reason: 'same-as-temporary' });
    assert.equal((await svc.completeFirstAccess('acme-demo', 'fict-a', 'short', proven)).ok, false);
    assert.deepEqual(await svc.completeFirstAccess('acme-demo', 'fict-a', NEXT, 'not-the-revision'), { ok: false, reason: 'not-required' });
    // an administrator reset after the person proved the first temporary password: the old proof no longer applies
    await svc.setTemporaryPassword('acme-demo', 'fict-admin', 'fict-a', TEMP + '2', 2);
    const reset = await rev('fict-a'); assert.notEqual(reset, proven);
    assert.deepEqual(await svc.completeFirstAccess('acme-demo', 'fict-a', NEXT, proven), { ok: false, reason: 'not-required' });
    assert.equal(await rev('fict-a'), reset);
    // expiry
    const realNow = svc.now; svc.now = () => Date.now() + 3 * 3_600_000;
    try {
      const exp = await svc.firstAccessState('acme-demo', 'fict-a'); assert.equal(exp.required && exp.expired, true);
      assert.deepEqual(await svc.completeFirstAccess('acme-demo', 'fict-a', NEXT, reset), { ok: false, reason: 'expired' });
    } finally { svc.now = realNow; }
    // two concurrent completions: a single winner
    const [a, b] = await Promise.all([svc.completeFirstAccess('acme-demo', 'fict-a', NEXT, reset), svc.completeFirstAccess('acme-demo', 'fict-a', NEXT + 'z', reset)]);
    assert.equal([a, b].filter((x) => x.ok).length, 1);
    assert.deepEqual((await svc.firstAccessState('acme-demo', 'fict-a')), { required: false });
    assert.equal(await svc.authenticate('acme-demo', 'fict-a', TEMP + '2'), false);
    assert.equal(await svc.authenticate('acme-demo', 'fict-a', a.ok ? NEXT : NEXT + 'z'), true);
  });
  it('a disabled account stays refused after a temporary password; enabling it again is a separate write that keeps the credential revision', async () => {
    await svc.save('fict-a', { login_enabled: false }, false, undefined, 'acme-demo');
    await svc.setTemporaryPassword('acme-demo', 'fict-admin', 'fict-a', TEMP + '3', 2);
    const r1 = await rev('fict-a');
    assert.equal(await svc.authenticate('acme-demo', 'fict-a', TEMP + '3'), false);
    await svc.save('fict-a', { login_enabled: true }, false, undefined, 'acme-demo');
    assert.equal(await rev('fict-a'), r1);
    assert.equal(await svc.authenticate('acme-demo', 'fict-a', TEMP + '3'), true);
    const st = await svc.firstAccessState('acme-demo', 'fict-a'); assert.equal(st.required && st.revision, r1);
  });
  it('block and temporary password written concurrently both hold; the workflow unblock lifts only its own kind and survives a concurrent lift', async () => {
    const blocks = new BlockStore(join(dir, 'blocks', 'b.json'));
    const events: any[] = [];
    const fx = (WorkflowEngine.prototype as any).accountEffects.call({ authn: { blocks }, events: { emit: (e: unknown) => events.push(e) } });
    const T = 'acme-demo', run = 'run-fict';
    const [blk] = await Promise.all([
      fx.block(T, { runId: run, subject: 'fict-a', kind: 'suspended', message: 'Badge in preparation.' }),
      svc.setTemporaryPassword(T, 'fict-admin', 'fict-a', TEMP + '4', 2),
    ]);
    assert.equal(blk.applied, true);
    const st = await svc.firstAccessState(T, 'fict-a'); assert.equal(st.required, true);
    assert.equal(await svc.authenticate(T, 'fict-a', TEMP + '4'), true);
    assert.equal(canSignIn(await blocks.list(T, 'fict-a'), Date.now()), false);
    // an administrator also set a lockout on the same account: it must survive the workflow unblock
    await blocks.add(T, { subject: 'fict-a', kind: 'locked', message: 'Admin lockout.', origin: 'admin', setBy: 'fict-admin', setAt: Date.now() } as never);
    const [x, y] = await Promise.all([fx.unblock(T, { runId: run, subject: 'fict-a', kind: 'suspended' }), fx.unblock(T, { runId: run, subject: 'fict-a', kind: 'suspended' })]);
    assert.ok(x.lifted + y.lifted >= 1);
    const left = await blocks.list(T, 'fict-a'); assert.deepEqual(left.map((b) => b.kind), ['locked']);
    assert.equal(canSignIn(left, Date.now()), false);
    assert.equal(await svc.authenticate(T, 'fict-a', TEMP + '4'), true);   // the password flow is untouched by the unblock
    const none = await fx.unblock(T, { runId: run, subject: 'fict-a', kind: 'suspended' }); assert.equal(none.lifted, 0);
  });
});
