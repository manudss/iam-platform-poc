import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VersioningService } from '../versioning/versioning.service.js';
import { WorkflowStore } from './store.js';
import { WorkflowTasksService } from './tasks.js';
import { externalBlock } from './model.js';
import { buildAuthnEffects } from './engine.js';
// Durable single use of a decided task, on the REAL Dolt engine and several real connections at once. Fictional data only.
const bin = process.env.DOLT_BIN ?? '', have = existsSync(bin);
describe('task consumption on real Dolt (concurrent connections)', { skip: !have && 'DOLT_BIN missing' }, () => {
  let dir: string, server: ChildProcess, store: WorkflowStore;
  const saved: Record<string, string | undefined> = {};
  const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
  const mk = (id: string, status: string) => ({ id, tenant: 'acme', kind: 'lyam-propose-password-reset', title: 't', detail: { subject: 'u1', hours: '24' }, assignee: 'boss', delegated_to: null, status, decision: status === 'decided' ? 'approved' : null, justification: null, decided_by: status === 'decided' ? 'boss' : null, run_id: 'run-1', node_id: 'n1', prevent_self: true, created_at: now(), due_at: null, reminded_at: null, decided_at: status === 'decided' ? now() : null });
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wf-consume-')); const home = join(dir, 'h'), data = join(dir, 'd'); mkdirSync(home); mkdirSync(data); const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'test'], ['user.email', 'test@example.invalid']]) assert.equal(spawnSync(bin, ['config', '--global', '--add', k, v], { env }).status, 0);
    assert.equal(spawnSync(bin, ['sql'], { cwd: data, env, input: readFileSync(resolve('../../data/demo/01-schema.sql')) }).status, 0);
    server = spawn(bin, ['sql-server', '--host', '127.0.0.1', '--port', '14378', '--data-dir', data], { env, cwd: data, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if (spawnSync(bin, ['--host', '127.0.0.1', '--port', '14378', '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await new Promise((r) => setTimeout(r, 100)); }
    for (const k of ['DOLT_PORT', 'DOLT_DATABASE']) saved[k] = process.env[k];
    Object.assign(process.env, { DOLT_PORT: '14378', DOLT_DATABASE: 'iam' });
    store = new WorkflowStore(new VersioningService());
  });
  after(async () => { server?.kill(); await new Promise((r) => setTimeout(r, 500)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  it('exactly one of many concurrent consumers wins; the same consumer is idempotent; an open task cannot be consumed', async () => {
    await store.putTask(mk('task-d', 'decided') as never);
    await store.putTask(mk('task-o', 'open') as never);
    const consumers = Array.from({ length: 12 }, (_, i) => `run-${i}:n1`);
    const results = await Promise.all(consumers.map((c) => store.consumeTask('task-d', c)));
    const winners = results.map((r, i) => (r.ok ? consumers[i] : null)).filter(Boolean);
    assert.equal(winners.length, 1, JSON.stringify(results));
    const t = await store.getTask('task-d');
    assert.equal((t!.detail as { consumedBy?: string }).consumedBy, winners[0]);
    assert.equal((t!.detail as { subject?: string }).subject, 'u1', 'the rest of the detail is intact');
    assert.equal((await store.consumeTask('task-d', winners[0]!)).ok, true, 'same consumer, idempotent before the effect is recorded');
    const stranger = consumers.find((c) => c !== winners[0])!;
    assert.equal(await store.markTaskApplied('task-d', stranger, 'rev-x'), false, 'only the claiming consumer records the effect');
    const both = await Promise.all([store.markTaskApplied('task-d', winners[0]!, 'rev-1'), store.markTaskApplied('task-d', winners[0]!, 'rev-2')]);
    assert.deepEqual(both.filter(Boolean).length, 1, 'the effect is recorded once');
    const burned = await store.consumeTask('task-d', winners[0]!);
    assert.equal(burned.ok, false); assert.equal(burned.applied, true, 'burned: even the same consumer cannot claim again');
    const t2 = await store.getTask('task-d'); assert.match(String((t2!.detail as { appliedRevision?: string }).appliedRevision), /^rev-[12]$/);
    assert.equal((await store.consumeTask('task-d', 'run-x:n9')).ok, false);
    assert.equal((await store.consumeTask('task-o', 'run-1:n1')).ok, false);
  });
  it('REAL tasks service + REAL store + real blocks: apply claims and records its revision, a failed recording is replayed by the same node only, publish accepts only the recorded revision, other nodes and runs are refused', async () => {
    const savedAdmins = process.env.IAM_API_ADMIN_SUBJECTS; process.env.IAM_API_ADMIN_SUBJECTS = 'boss';
    try {
    await store.putTask(mk('task-s', 'decided') as never);
    const svc = new WorkflowTasksService(store);
    let failOnce = true; const realMark = svc.markApplied.bind(svc);
    (svc as unknown as { markApplied: unknown }).markApplied = async (...a: [string, string, string, string]) => { if (failOnce) { failOnce = false; throw new Error('record failed'); } return realMark(...a); };
    const writes: string[] = []; let n = 0;
    const base: any = { tenant: 'acme', config: {}, settings: {}, dryRun: false, log: () => {}, outputs: {}, runId: 'run-1', tasks: svc, authn: buildAuthnEffects({} as never, svc), secrets: { reveal: () => 'x' }, setTemporaryPassword: async () => { writes.push('w'); return { revision: `rev-${++n}-12345`, expiresAt: Date.now() + 1000 }; } };
    const apply = externalBlock('lyam-apply-password-reset')!, pub = externalBlock('lyam-publish-workspace')!;
    const cfg = apply.validate({ approvalTaskId: 'task-s', subject: 'u1', passwordRef: 'ref', hours: '24' } as never);
    const run = (nodeId: string, runId = 'run-1') => apply.run({ ...base, runId, nodeId, config: cfg } as never) as Promise<{ revision: string }>;
    await assert.rejects(run('n1'), /record failed/); assert.equal(writes.length, 1);
    await assert.rejects(run('n2'), /already consumed/); assert.equal(writes.length, 1, 'another node: no write');
    const out = await run('n1'); assert.equal(writes.length, 2, 'same node replay rewrote the credential'); assert.equal(out.revision, 'rev-2-12345');
    await assert.rejects(run('n1'), /burned/); await assert.rejects(run('n3'), /burned/); assert.equal(writes.length, 2, 'burned after the recording');
    const publish = (rev: string, runId = 'run-1') => pub.run({ ...base, runId, hasRunBranch: true, publishIntent: { branch: 'b', head: 'h' }, workspace: { publish: async (_t: string, a: { precheck?: () => Promise<void> }) => { await a.precheck?.(); return { published: true, mainCommit: 'm', branch: 'b', sourceHead: 'h' }; } }, config: pub.validate({ resetApprovalTaskId: 'task-s', resetSubject: 'u1', resetHours: '24', resetRevision: rev } as never) } as never) as Promise<{ published: boolean }>;
    await assert.rejects(publish('rev-1-12345'), /not applied by this run/);
    assert.equal((await publish('rev-2-12345')).published, true);
    await assert.rejects(publish('rev-2-12345', 'run-other'), /another run/);
    // real administrator list: a promotion is only an operator change of the server env; an empty list fails closed (checked at every call)
    process.env.IAM_API_ADMIN_SUBJECTS = 'boss,u1'; await assert.rejects(publish('rev-2-12345'), /administrator now/);
    process.env.IAM_API_ADMIN_SUBJECTS = ''; await assert.rejects(publish('rev-2-12345'), /list is empty/);
    } finally { if (savedAdmins === undefined) delete process.env.IAM_API_ADMIN_SUBJECTS; else process.env.IAM_API_ADMIN_SUBJECTS = savedAdmins; }
  });
  it('REAL process death between the claim and the recording: the claim is durable, other consumers stay refused, only the same consumer can resume and record', async () => {
    await store.putTask(mk('task-k', 'decided') as never);
    const storeUrl = new URL('./store.js', import.meta.url).href, versUrl = new URL('../versioning/versioning.service.js', import.meta.url).href;
    const code = `import('${versUrl}').then(async (v)=>{const {WorkflowStore}=await import('${storeUrl}');const st=new WorkflowStore(new v.VersioningService());const r=await st.consumeTask('task-k','run-9:n1');process.stdout.write(JSON.stringify(r));process.exit(137);})`;
    const child = spawnSync(process.execPath, ['--input-type=commonjs', '-e', code], { env: { ...process.env }, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 137, 'the child died right after the claim: ' + child.stderr);
    assert.equal(JSON.parse(child.stdout).ok, true);
    const t = await store.getTask('task-k'); assert.equal((t!.detail as { consumedBy?: string }).consumedBy, 'run-9:n1'); assert.equal((t!.detail as { appliedBy?: string }).appliedBy, undefined);
    assert.equal((await store.consumeTask('task-k', 'run-9:n2')).ok, false, 'another node cannot take over');
    assert.equal((await store.consumeTask('task-k', 'run-8:n1')).ok, false, 'another run cannot take over');
    assert.equal((await store.consumeTask('task-k', 'run-9:n1')).ok, true, 'the same node can resume');
    assert.equal(await store.markTaskApplied('task-k', 'run-9:n1', 'rev-k-12345'), true);
  });
});
