import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';
import { localTestPort } from '../testing/local-test-port.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { WorkflowReads } from './reads.js';
import { WorkflowStore } from './store.js';
import { WorkflowTasksService } from './tasks.js';
import { WorkflowsIgaService } from './iga.service.js';

// Real SQL/main reads and durable tasks. Fictional local directory, no provider/account effects.
const bin = process.env.DOLT_BIN ?? '';
describe('IGA live deciders and durable review ownership (real Dolt)', { skip: !existsSync(bin) && 'DOLT_BIN missing' }, () => {
  let dir: string, server: ChildProcess, port: number, store: WorkflowStore, reads: WorkflowReads, service: WorkflowTasksService;
  const env = { ...process.env };
  const events: Record<string, any>[] = [];
  before(async () => {
    port = await localTestPort();
    dir = mkdtempSync(join(tmpdir(), 'iga-deciders-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const childEnv = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'test'], ['user.email', 'test@example.invalid'], ['metrics.disabled', 'true']]) assert.equal(spawnSync(bin, ['config', '--global', '--add', k, v], { env: childEnv }).status, 0);
    assert.equal(spawnSync(bin, ['sql'], { cwd: data, env: childEnv, input: readFileSync(resolve('../../data/demo/01-schema.sql')) }).status, 0);
    server = spawn(bin, ['sql-server', '--host', '127.0.0.1', '--port', String(port), '--data-dir', data], { cwd: data, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '', ready = false;
    for (const stream of [server.stdout, server.stderr]) stream?.on('data', (data) => { diagnostic = (diagnostic + data).slice(-4000); });
    for (let i = 0; i < 100; i++) {
      assert.equal(server.exitCode, null, diagnostic);
      try { const c = await createConnection({ host: '127.0.0.1', port, user: 'root', connectTimeout: 500 }); try { await c.query('select 1'); } finally { await c.end(); } ready = true; break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(ready, diagnostic);
    Object.assign(process.env, { DOLT_PORT: String(port), DOLT_DATABASE: 'iam', IAM_API_ADMIN_SUBJECTS: 'admin', IAM_API_IGA_SUBJECTS: 'disabled,missing,active' });
    const versioning = new VersioningService(); store = new WorkflowStore(versioning); reads = new WorkflowReads(versioning);
    service = new WorkflowTasksService(store, { emit: (e: Record<string, any>) => events.push(e) } as never, undefined, reads);
    await sql("alter table identities add column login_enabled boolean not null default false");
    for (const [id, enabled, manager] of [['disabled', false, null], ['active', true, null], ['admin', true, null], ['boss-a', true, null], ['boss-b', true, null], ['employee', true, 'boss-a']] as const) await sql('insert into identities (id, display_name, department, manager_id, login_enabled) values (?, ?, null, ?, ?)', [id, id, manager, enabled]);
  });
  after(async () => { server?.kill(); await new Promise((r) => setTimeout(r, 400)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.env = { ...env }; });
  async function sql(q: string, values: unknown[] = []) {
    const c = await createConnection({ host: '127.0.0.1', port, user: 'root', database: 'iam/main' });
    try { return await c.query(q, values); } finally { await c.end(); }
  }
  const input = (node: string, assignee = 'iga') => ({ tenant: 'acme', kind: 'iga-review', title: 'Review employee', detail: { identity: 'employee', decisions: ['approved', 'denied'] }, assignee, preventSelfApproval: true, runId: 'run-1', nodeId: node, dueInSeconds: 3600 });
  it('real main skips disabled and missing members and persists the active pool assignment', async () => {
    const task = await service.request(input('pool'));
    assert.equal(task.assignee, 'active'); assert.equal(task.detail.pool, 'iga');
    const saved = (await store.getTask(task.id))!;
    assert.equal(saved.assignee, 'active'); assert.equal(saved.detail.identity, 'employee');
  });
  it('all inactive candidates fail without writing a task or emitting assignment', async () => {
    const saved = process.env.IAM_API_IGA_SUBJECTS; process.env.IAM_API_IGA_SUBJECTS = 'disabled,missing';
    try {
      const before = events.length;
      await assert.rejects(service.request(input('none')), /no eligible/);
      assert.equal(events.length, before);
      assert.ok(!(await store.listTasks('acme', { runId: 'run-1' })).some((t) => t.node_id === 'none'));
    } finally { process.env.IAM_API_IGA_SUBJECTS = saved; }
  });
  it('a new service/store instance reuses the same durable review and deadline without a second event', async () => {
    const first = await service.request(input('restart'));
    const fresh = new WorkflowTasksService(new WorkflowStore(new VersioningService()), undefined, undefined, new WorkflowReads(new VersioningService()));
    const again = await fresh.request(input('restart'));
    assert.equal(again.id, first.id); assert.equal(again.due_at, first.due_at);
    assert.equal((await store.listTasks('acme', { runId: 'run-1' })).filter((t) => t.node_id === 'restart').length, 1);
  });
  async function campaignReview() {
    await sql("update identities set manager_id = 'boss-a' where id = 'employee'");
    const iga = new WorkflowsIgaService(store, service, reads);
    const campaign = await iga.createCampaign('acme', 'admin', { name: 'Manager review', scope: { users: ['employee'] } });
    const item = (await iga.listItems('acme', campaign.id)).items[0];
    assert.equal(item.payload.manager, 'boss-a', 'the real campaign records the manager, not only the roles');
    const opened = await iga.openReviewTasks('acme', 'workflow:review-run', campaign.id, { assignTo: 'manager', runId: 'review-' + campaign.id, dueInDays: 3 });
    const task = (await store.getTask(opened.tasks[0].task!))!;
    assert.equal(task.assignee, 'boss-a'); assert.equal(task.detail.reviewManager, 'boss-a');
    return { iga, campaign, task };
  }
  it('real campaign initially assigns its current active manager; a changed manager cannot decide without explicit reassignment', async () => {
    const { iga, campaign, task } = await campaignReview();
    await sql("update identities set manager_id = 'boss-b' where id = 'employee'");
    for (const actor of ['boss-a', 'boss-b', 'admin']) await assert.rejects(service.decide('acme', task.id, actor, 'approved', 'reviewed'), /manager changed/);
    assert.equal((await store.getTask(task.id))!.assignee, 'boss-a', 'no silent reassignment');
    const moved = await iga.reassignReviewTasks('acme', 'workflow:review-run', campaign.id, { from: 'boss-a', to: 'manager', startedBy: 'admin', reason: 'manager changed in directory' });
    assert.deepEqual(moved.reassigned, [task.id]); assert.equal(moved.refused.length, 0);
    const current = (await store.getTask(task.id))!;
    assert.equal(current.id, task.id); assert.equal(current.assignee, 'boss-b'); assert.equal(current.delegated_to, null);
    assert.equal(current.due_at, task.due_at); assert.equal(current.run_id, task.run_id); assert.equal(current.detail.itemId, task.detail.itemId);
    assert.equal(current.detail.reviewManager, 'boss-b'); assert.equal(current.detail.reviewAssignmentVersion, 1);
    assert.equal(current.detail.reassignedStartedBy, 'admin');
    assert.equal((current.detail.reviewAssignmentHistory as any[])[0].from, 'boss-a');
    assert.equal(service.isDeciderAdmin('boss-b'), false, 'current manager gets review ownership, never admin membership');
    await assert.rejects(service.decide('acme', task.id, 'boss-a', 'approved', 'stale review'), /assigned decider/);
    const decided = await service.decide('acme', task.id, 'boss-b', 'approved', 'current manager reviewed');
    assert.equal(decided.decided_by, 'boss-b');
    assert.equal((await iga.recordTaskDecisions('acme', [task.id])).recorded[0].recorded, 'approved');
  });
  it('current main manager is read at opening, not silently taken from a stale campaign snapshot', async () => {
    const iga = new WorkflowsIgaService(store, service, reads);
    await sql("update identities set manager_id = 'boss-a' where id = 'employee'");
    const campaign = await iga.createCampaign('acme', 'admin', { name: 'Before change', scope: { users: ['employee'] } });
    await sql("update identities set manager_id = 'boss-b' where id = 'employee'");
    const opened = await iga.openReviewTasks('acme', 'workflow:r', campaign.id, { assignTo: 'manager' });
    assert.equal(opened.tasks[0].assignee, 'boss-b');
    assert.equal((await store.getTask(opened.tasks[0].task!))!.detail.reviewManager, 'boss-b');
  });
  it('a disabled, missing or self manager cannot be the replacement; task, deadline and audit stay unchanged', async () => {
    const { task } = await campaignReview();
    for (const manager of ['disabled', 'missing', 'employee']) {
      await sql('update identities set manager_id = ? where id = ?', [manager, 'employee']);
      await assert.rejects(service.reassignOpen('acme', task.id, 'manager', 'workflow:r', 'changed', 'admin'));
      assert.deepEqual(await store.getTask(task.id), task);
    }
  });
  it('an inactive pool actor cannot decide even with admin membership; a live pool member can', async () => {
    const task = await service.request(input('active-actor'));
    const saved = process.env.IAM_API_ADMIN_SUBJECTS; process.env.IAM_API_ADMIN_SUBJECTS = 'admin,disabled';
    try { await assert.rejects(service.decide('acme', task.id, 'disabled', 'approved', 'reviewed'), /login enabled/); }
    finally { process.env.IAM_API_ADMIN_SUBJECTS = saved; }
    assert.equal((await service.decide('acme', task.id, 'active', 'approved', 'reviewed')).decided_by, 'active');
  });
  it('explicit review delegation transfers ownership; the old manager cannot decide or delegate again', async () => {
    const { task } = await campaignReview();
    const moved = await service.delegate('acme', task.id, 'boss-a', 'boss-b');
    assert.equal(moved.assignee, 'boss-b'); assert.equal(moved.due_at, task.due_at); assert.equal(moved.detail.reviewManager, undefined);
    await assert.rejects(service.decide('acme', task.id, 'boss-a', 'approved', 'old authority'), /assigned decider/);
    await assert.rejects(service.delegate('acme', task.id, 'boss-a', 'active'), /current review decider/);
    assert.equal((await service.decide('acme', task.id, 'boss-b', 'approved', 'delegated review')).decided_by, 'boss-b');
  });
  it('a decision already validated for A is refused if reassignment to B wins before the SQL decision write', async () => {
    const { task } = await campaignReview();
    const original = store.decideReviewTask.bind(store);
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((r) => { release = r; }), entered = new Promise<void>((r) => { reached = r; });
    store.decideReviewTask = async (...args) => { reached(); await held; return original(...args); };
    const pending = service.decide('acme', task.id, 'boss-a', 'approved', 'validated before move');
    // Attach a handler before the competing operation, so a regression is not an unhandled rejection.
    const outcome = pending.then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error }));
    try {
      await entered;
      await sql("update identities set manager_id = 'boss-b' where id = 'employee'");
      await service.reassignOpen('acme', task.id, 'manager', 'workflow:r', 'explicit manager change', 'admin');
      release(); const result = await outcome;
      assert.equal(result.value, null); assert.match(result.error!.message, /assigned decider/);
      assert.equal((await store.getTask(task.id))!.status, 'open');
    } finally { release(); store.decideReviewTask = original; }
    assert.equal((await service.decide('acme', task.id, 'boss-b', 'approved', 'reviewed by B')).decided_by, 'boss-b');
  });
  it('a decision that wins first makes the held reassignment fail without rewriting its audit or owner', async () => {
    const task = await service.request(input('decision-first'));
    const original = store.reassignReviewTask.bind(store);
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((r) => { release = r; }), entered = new Promise<void>((r) => { reached = r; });
    store.reassignReviewTask = async (...args) => { reached(); await held; return original(...args); };
    const outcome = service.reassignOpen('acme', task.id, 'admin', 'workflow:r', 'replacement', 'admin').then((value) => ({ value, error: null }), (error: Error) => ({ value: null, error }));
    try {
      await entered;
      const decided = await service.decide('acme', task.id, 'active', 'approved', 'decision won');
      release(); const result = await outcome;
      assert.equal(result.value, null); assert.match(result.error!.message, /changed while reassigning/);
      assert.deepEqual(await store.getTask(task.id), decided);
    } finally { release(); store.reassignReviewTask = original; }
  });
  it('two real SQL reassignments of the same snapshot have one winner; ABA ownership does not revive a stale snapshot', async () => {
    const task = await service.request(input('competing-moves'));
    const outcomes = await Promise.all(['boss-a', 'boss-b'].map((target) => store.reassignReviewTask(task, target, { ...task.detail, reviewAssignmentVersion: 1 })));
    assert.equal(outcomes.filter(Boolean).length, 1);
    const winner = (await store.getTask(task.id))!;
    assert.ok(await store.reassignReviewTask(winner, task.assignee, { ...winner.detail, reviewAssignmentVersion: 2 }));
    assert.equal(await store.decideReviewTask(task, 'active', 'approved', 'stale ABA', new Date().toISOString(), true), null);
    assert.equal(await store.patchReviewTaskDetail(task, { ...task.detail, escalationError: 'stale' }), false);
  });
  it('a restarted service preserves the reassignment and history; it does not restore former manager authority', async () => {
    const { task } = await campaignReview();
    await sql("update identities set manager_id = 'boss-b' where id = 'employee'");
    await service.reassignOpen('acme', task.id, 'manager', 'workflow:r', 'manager update', 'admin');
    const freshStore = new WorkflowStore(new VersioningService());
    const fresh = new WorkflowTasksService(freshStore, undefined, undefined, new WorkflowReads(new VersioningService()));
    const current = (await freshStore.getTask(task.id))!;
    assert.equal(current.assignee, 'boss-b'); assert.equal((current.detail.reviewAssignmentHistory as any[]).length, 1); assert.equal(current.due_at, task.due_at);
    await assert.rejects(fresh.decide('acme', task.id, 'boss-a', 'approved', 'stale'), /assigned decider/);
    assert.equal((await fresh.decide('acme', task.id, 'boss-b', 'approved', 'reviewed')).decided_by, 'boss-b');
  });

});
