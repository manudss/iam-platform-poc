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
});
