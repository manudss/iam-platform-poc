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
import { branchContext } from '../workspace/context.js';
import { WorkspacePublisher } from '../workspace/workspace-publisher.js';
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
  it('block and temporary password written concurrently both hold; the unblock lifts only blocks its own run set and survives a concurrent lift', async () => {
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
    // an administrator lockout and another run's block on the same account: both must survive the unblock
    await blocks.add(T, { subject: 'fict-a', kind: 'locked', message: 'Admin lockout.', origin: 'admin', setBy: 'fict-admin', setAt: Date.now() } as never);
    await fx.block(T, { runId: 'run-other', subject: 'fict-a', kind: 'pending_approval', message: 'Other run.' });
    const [x, y] = await Promise.all([fx.unblock(T, { runId: run, subject: 'fict-a', kind: 'suspended', ownerRun: run }), fx.unblock(T, { runId: run, subject: 'fict-a', kind: 'suspended', ownerRun: run })]);
    assert.ok(x.lifted + y.lifted >= 1);
    const left = await blocks.list(T, 'fict-a'); assert.deepEqual(left.map((b) => b.kind).sort(), ['locked', 'pending_approval']);
    assert.equal(canSignIn(left, Date.now()), false);
    assert.equal(await svc.authenticate(T, 'fict-a', TEMP + '4'), true);   // the password flow is untouched by the unblock
    const none = await fx.unblock(T, { runId: run, subject: 'fict-a', kind: 'suspended', ownerRun: run }); assert.equal(none.lifted, 0); assert.equal(none.remaining, 2);
  });
  it('double phase 1 on the same account: one owned suspension survives (last writer wins), the other run fails closed and a sequential retry cannot take the block over', async () => {
    const blocks = new BlockStore(join(dir, 'blocks4', 'b.json'));
    const fx = (WorkflowEngine.prototype as any).accountEffects.call({ authn: { blocks }, events: { emit: () => {} } });
    const T = 'acme-demo';
    const [a, b] = await Promise.all([
      fx.block(T, { runId: 'run-a', subject: 'fict-d', kind: 'suspended', message: 'Badge A.' }),
      fx.block(T, { runId: 'run-b', subject: 'fict-d', kind: 'suspended', message: 'Badge B.' }),
    ]);
    assert.equal(a.applied && b.applied, true, 'check-then-add is not atomic across runs: both believe they blocked');
    const inForce = await blocks.list(T, 'fict-d');
    assert.equal(inForce.length, 1, 'the store serializes writes and the same kind replaces: a single suspension survives');
    const winner = inForce[0].setBy === 'workflow:run-a' ? 'run-a' : 'run-b';
    const loser = winner === 'run-a' ? 'run-b' : 'run-a';
    const r = await fx.unblock(T, { runId: loser, subject: 'fict-d', kind: 'suspended', ownerRun: loser });
    assert.equal(r.lifted, 0, 'the losing run never lifts the surviving block'); assert.equal(r.remaining, 1, 'its phase 2 then fails closed');
    const retry = await fx.block(T, { runId: 'run-c', subject: 'fict-d', kind: 'suspended', message: 'Retry.' });
    assert.equal(retry.applied, false, 'a sequential new run sees the block and does not take it over'); assert.equal(retry.blockId, inForce[0].id);
    assert.equal((await blocks.list(T, 'fict-d'))[0].setBy, `workflow:${winner}`);
  });
  it('workspace mode: the temporary password lives on the run branch only; main keeps the old password until the branch is merged, then the first-access rule is in force on main', async () => {
    await svc.seedAccount({ id: 'fict-b', display_name: 'Fictional B', department: 'IT', manager_id: null, email: 'b@example.invalid' }, SEED);
    const mainRev = await rev('fict-b');
    await v.createBranch('run-fict', 'main');
    process.env.IAM_WORKSPACE_MODE = '1';
    try {
      const r = await branchContext.run({ branch: 'run-fict' }, () => svc.setTemporaryPassword('acme-demo', 'fict-admin', 'fict-b', TEMP + '5', 2));
      assert.equal(r.ref, 'run-fict'); assert.equal(r.pendingPublication, true);
      assert.equal(await rev('fict-b'), mainRev);                                             // main untouched
      assert.deepEqual(await svc.firstAccessState('acme-demo', 'fict-b'), { required: false });  // no rule on main yet
      assert.equal(await svc.authenticate('acme-demo', 'fict-b', SEED), true);
      assert.equal(await svc.authenticate('acme-demo', 'fict-b', TEMP + '5'), false);
      const onBranch = await svc.firstAccessState('acme-demo', 'fict-b', 'run-fict'); assert.equal(onBranch.required, true);
      // plain Dolt merge of the branch into main (the publisher's checks and activation are NOT exercised here)
      await v.lock(() => v.at('main', async (c) => { await c.query("call dolt_merge('run-fict')"); }));
      const merged = await svc.firstAccessState('acme-demo', 'fict-b');
      assert.equal(merged.required, true); assert.equal(merged.required && merged.revision, onBranch.required ? onBranch.revision : '');
      assert.equal(await svc.authenticate('acme-demo', 'fict-b', TEMP + '5'), true);
      assert.equal(await svc.authenticate('acme-demo', 'fict-b', SEED), false);
    } finally { delete process.env.IAM_WORKSPACE_MODE; }
  });
  describe('publication by a run (real WorkspacePublisher and real versioning, activation stubbed)', () => {
    let activations: string[]; let mode: 'ok' | 'fail';
    let state: any; // what activation.current() answers
    const mkPub = () => {
      const registries = { drop: () => {}, get: async () => ({}) };
      const activation = {
        applyEnabled: true,
        current: async () => state,
        activate: async (_t: string, commit: string, requestId: string) => { activations.push(commit); if (mode === 'fail') { state = { state: 'failed', commit, requestId }; return state; } state = { state: 'applied', commit, requestId }; return state; },
      };
      return new WorkspacePublisher(v as never, registries as never, activation as never, undefined, undefined);
    };
    const runBranch = async (name: string, id: string) => {
      await svc.seedAccount({ id, display_name: id, department: 'IT', manager_id: null, email: `${id}@example.invalid` }, SEED);
      await v.createBranch(name, 'main');
      process.env.IAM_WORKSPACE_MODE = '1';
      try { await branchContext.run({ branch: name }, () => svc.setTemporaryPassword('acme-demo', 'fict-admin', id, TEMP + 'P', 2)); } finally { delete process.env.IAM_WORKSPACE_MODE; }
      return (await v.branches()).branches.find((b: any) => b.name === name)!.commit as string;
    };
    const mainHead = async () => (await v.branches()).branches.find((b: any) => b.name === 'main')!.commit as string;
    it('happy path: the temporary password goes live on main, activation applied, result read back from the real state', async () => {
      activations = []; mode = 'ok'; state = { state: 'applied', commit: 'old' };
      const head = await runBranch('run-pub-1', 'fict-p1');
      process.env.IAM_WORKSPACE_MODE = '1';
      try {
        const r: any = await mkPub().publishForRun({ tenant: 'acme-demo', runId: 'run-1', workflowId: 'wf-fict', branch: 'run-pub-1', expectedHead: head });
        assert.equal(r.published, true); assert.equal(r.mainCommit, await mainHead()); assert.equal(activations.length, 1);
      } finally { delete process.env.IAM_WORKSPACE_MODE; }
      assert.equal(await svc.authenticate('acme-demo', 'fict-p1', TEMP + 'P'), true);
      assert.equal((await svc.firstAccessState('acme-demo', 'fict-p1')).required, true);
    });
    it('crash after merge, before activation: not reported as published, the data is already on main; a retry of the same head, in the same process or after a restart, only activates and never merges twice', async () => {
      activations = []; mode = 'fail'; state = { state: 'applied', commit: 'old' };
      const head = await runBranch('run-pub-2', 'fict-p2');
      process.env.IAM_WORKSPACE_MODE = '1';
      try {
        const pub = mkPub();
        await assert.rejects(() => pub.publishForRun({ tenant: 'acme-demo', runId: 'run-2', workflowId: 'wf-fict', branch: 'run-pub-2', expectedHead: head }), /not confirmed/);
        const mergedMain = await mainHead();
        assert.equal(await svc.authenticate('acme-demo', 'fict-p2', TEMP + 'P'), true);       // merged: the data is on main even though activation failed
        // same process, same head: resumes
        mode = 'ok';
        const r1: any = await pub.publishForRun({ tenant: 'acme-demo', runId: 'run-2', workflowId: 'wf-fict', branch: 'run-pub-2', expectedHead: head });
        assert.equal(r1.published, true); assert.equal(await mainHead(), mergedMain);         // no second merge commit
        assert.equal(activations.length, 2);
        // a restart (new instance, the pending map is lost) after another failed activation of the same state
        mode = 'fail'; state = { state: 'failed', commit: mergedMain, requestId: `workspace-${mergedMain}` };
        mode = 'ok';
        const r2: any = await mkPub().publishForRun({ tenant: 'acme-demo', runId: 'run-2', workflowId: 'wf-fict', branch: 'run-pub-2', expectedHead: head });
        assert.equal(r2.published, true); assert.equal(await mainHead(), mergedMain);
      } finally { delete process.env.IAM_WORKSPACE_MODE; }
    });
    it('precheck: a rejection inside the queue refuses the publication with nothing merged and nothing activated; a queued publication is re-checked AFTER the one ahead of it merged', async () => {
      activations = []; mode = 'ok'; state = { state: 'applied', commit: 'old' };
      const headA = await runBranch('run-pre-a', 'fict-pa'), headB = await runBranch('run-pre-b', 'fict-pb');
      process.env.IAM_WORKSPACE_MODE = '1';
      try {
        const pub = mkPub(); const before = await mainHead();
        // 1) rejected precheck: nothing merged, nothing activated, the credential is not live
        await assert.rejects(() => pub.publishForRun({ tenant: 'acme-demo', runId: 'run-pa', workflowId: 'wf-fict', branch: 'run-pre-a', expectedHead: headA, precheck: async () => { throw new Error('guard flipped'); } }), /guard flipped/);
        assert.equal(await mainHead(), before); assert.equal(activations.length, 0);
        assert.equal(await svc.authenticate('acme-demo', 'fict-pa', TEMP + 'P'), false);
        // 2) two publications queued on one publisher: the second precheck runs after the first has merged, and its refusal leaves only the first on main
        let sawMainMoved = false; const afterFirst: string[] = [];
        const first = pub.publishForRun({ tenant: 'acme-demo', runId: 'run-pa', workflowId: 'wf-fict', branch: 'run-pre-a', expectedHead: headA });
        const second = pub.publishForRun({ tenant: 'acme-demo', runId: 'run-pb', workflowId: 'wf-fict', branch: 'run-pre-b', expectedHead: headB, precheck: async () => { afterFirst.push(await mainHead()); sawMainMoved = afterFirst[0] !== before; throw new Error('state changed while queued'); } });
        const [r1, r2] = await Promise.allSettled([first, second]);
        assert.equal(r1.status, 'fulfilled'); assert.equal(r2.status, 'rejected');
        assert.equal(sawMainMoved, true, 'the precheck of the queued publication ran after the first merge');
        assert.equal(await svc.authenticate('acme-demo', 'fict-pa', TEMP + 'P'), true);
        assert.equal(await svc.authenticate('acme-demo', 'fict-pb', TEMP + 'P'), false, 'the refused publication left its credential off main');
      } finally { delete process.env.IAM_WORKSPACE_MODE; }
    });
    it('through the REAL engine publish wrapper (allow-list gate included): the precheck reaches the real publisher inside its queue, a rejection merges nothing', async () => {
      activations = []; mode = 'ok'; state = { state: 'applied', commit: 'old' };
      const head = await runBranch('run-pre-w', 'fict-pw');
      const ws = (WorkflowEngine.prototype as any).workspaceEffects.call({ publisher: mkPub(), settingsFor: async () => ({ publishAllowedWorkflows: 'wf-fict' }) }, v);
      process.env.IAM_WORKSPACE_MODE = '1';
      try {
        const before = await mainHead(); let ran = 0;
        await assert.rejects(() => ws.publish('acme-demo', { runId: 'run-w', workflowId: 'wf-fict', branch: 'run-pre-w', expectedHead: head, precheck: async () => { ran++; throw new Error('guard flipped'); } }), /guard flipped/);
        assert.equal(ran, 1); assert.equal(await mainHead(), before); assert.equal(activations.length, 0);
        const ok = await ws.publish('acme-demo', { runId: 'run-w', workflowId: 'wf-fict', branch: 'run-pre-w', expectedHead: head, precheck: async () => { ran++; } });
        assert.equal(ok.published, true); assert.equal(ran, 2);
        await assert.rejects(() => ws.publish('acme-demo', { runId: 'run-w', workflowId: 'wf-other', branch: 'run-pre-w', expectedHead: head, precheck: async () => {} }), /not authorized/);
      } finally { delete process.env.IAM_WORKSPACE_MODE; }
    });
    it('a block written while the publication runs is neither lost nor undone, and the workflow unblock then lifts the block its own run set', async () => {
      activations = []; mode = 'ok'; state = { state: 'applied', commit: 'old' };
      const head = await runBranch('run-pub-3', 'fict-p3');
      const blocks = new BlockStore(join(dir, 'blocks3', 'b.json'));
      const fx = (WorkflowEngine.prototype as any).accountEffects.call({ authn: { blocks }, events: { emit: () => {} } });
      process.env.IAM_WORKSPACE_MODE = '1';
      try {
        const [pub, blk] = await Promise.all([
          mkPub().publishForRun({ tenant: 'acme-demo', runId: 'run-3', workflowId: 'wf-fict', branch: 'run-pub-3', expectedHead: head }),
          fx.block('acme-demo', { runId: 'run-3', subject: 'fict-p3', kind: 'suspended', message: 'Badge in preparation.' }),
        ]);
        assert.equal((pub as any).published, true); assert.equal(blk.applied, true);
      } finally { delete process.env.IAM_WORKSPACE_MODE; }
      assert.equal(canSignIn(await blocks.list('acme-demo', 'fict-p3'), Date.now()), false);
      assert.equal(await svc.authenticate('acme-demo', 'fict-p3', TEMP + 'P'), true);
      const un = await fx.unblock('acme-demo', { runId: 'run-3', subject: 'fict-p3', kind: 'suspended', ownerRun: 'run-3' });
      assert.equal(un.lifted, 1); assert.equal(un.remaining, 0);
      assert.equal(canSignIn(await blocks.list('acme-demo', 'fict-p3'), Date.now()), true);
    });
  });
});
