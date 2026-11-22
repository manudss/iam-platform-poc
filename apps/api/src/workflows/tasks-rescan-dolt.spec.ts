import 'reflect-metadata';
process.env.IAM_API_ADMIN_SUBJECTS = 'root';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkflowStore } from './store.js';
import { WorkflowTasksService } from './tasks.js';
import type { TaskRow } from './store.js';

/**
 * Reviewer point 1, proven on a REAL Dolt: a rescan task (the publication merge watch) must be picked
 * up by listDueTasks on EVERY tick (the json_extract(rescan) = true comparison is the suspect), reminded
 * exactly once, and its run re-kicked on every tick - without a restart or any human action - until the
 * task is decided. A plain overdue task is reminded once and never reprocessed.
 */
const bin = process.env.DOLT_BIN ?? '';
const have = existsSync(bin);
const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
const past = () => new Date(Date.now() - 60000).toISOString().slice(0, 23).replace('T', ' ');

const mkTask = (over: Partial<TaskRow>): TaskRow => ({
  id: 'task-x', tenant: 'acme', kind: 'publish-merge-watch', title: 't', detail: {}, assignee: 'root', delegated_to: null,
  status: 'open', decision: null, justification: null, decided_by: null, run_id: 'run-1', node_id: 'n1',
  prevent_self: false, created_at: now(), due_at: past(), reminded_at: null, decided_at: null, ...over,
});

describe('rescan tasks across several overdue ticks (real Dolt)', { skip: !have && 'DOLT_BIN missing' }, () => {
  let dir: string, proc: ChildProcess, store: WorkflowStore, kicks: string[];
  let svc: WorkflowTasksService;
  const saved: Record<string, string | undefined> = {};
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wf-rescan-'));
    const home = join(dir, 'h'), data = join(dir, 'd'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v2] of [['user.name', 'test'], ['user.email', 'test@example.invalid'], ['metrics.disabled', 'true']]) assert.equal(spawnSync(bin, ['config', '--global', '--add', k, v2], { env }).status, 0);
    assert.equal(spawnSync(bin, ['sql'], { cwd: data, env, input: readFileSync(resolve('../../data/demo/01-schema.sql')) }).status, 0);
    proc = spawn(bin, ['sql-server', '--host', '127.0.0.1', '--port', '14380', '--data-dir', data], { env, cwd: data, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if (spawnSync(bin, ['--host', '127.0.0.1', '--port', '14380', '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await new Promise((r) => setTimeout(r, 200)); }
    for (const k of ['DOLT_PORT', 'DOLT_DATABASE']) saved[k] = process.env[k];
    Object.assign(process.env, { DOLT_PORT: '14380', DOLT_DATABASE: 'iam' });
    store = new WorkflowStore();
    kicks = [];
    svc = new WorkflowTasksService(store, undefined, { get: () => ({ kick: (id: string) => kicks.push(id) }) } as never);
  });
  after(async () => { proc?.kill(); await new Promise((r) => setTimeout(r, 500)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('a rescan task is re-kicked on every tick but reminded once; a plain task is reminded once and dropped', async () => {
    await store.putTask(mkTask({ id: 'task-rescan', detail: { rescan: true, decisions: ['merged', 'abandoned'] } }));
    await store.putTask(mkTask({ id: 'task-plain', kind: 'approval', detail: {} }));

    // Tick 1: both are due, both reminded, both runs kicked.
    await svc.scanOverdue();
    const r1 = (await store.getTask('task-rescan'))!, p1 = (await store.getTask('task-plain'))!;
    assert.ok(r1.reminded_at && p1.reminded_at, 'both reminded on the first tick');
    assert.equal(kicks.length, 2, 'both runs kicked on tick 1');

    // Tick 2 (no merge, no restart, no human action): ONLY the rescan task comes back - this is the
    // json_extract(detail, '$.rescan') = true comparison, executed by Dolt itself.
    kicks = [];
    await svc.scanOverdue();
    assert.deepEqual(kicks, ['run-1'], 'tick 2 re-kicks only the rescan run (the JSON comparison really matched on Dolt)');
    assert.equal((await store.getTask('task-rescan'))!.reminded_at, r1.reminded_at, 'no second reminder for the rescan task');
    assert.equal((await store.getTask('task-plain'))!.reminded_at, p1.reminded_at, 'the plain task is not reprocessed');

    // Tick 3: same - the watch survives as many ticks as needed.
    kicks = [];
    await svc.scanOverdue();
    assert.deepEqual(kicks, ['run-1'], 'tick 3 still re-kicks the rescan run');

    // The merge lands: the human decision settles the task, the scanner leaves it alone from then on.
    await svc.decide('acme', 'task-rescan', 'root', 'merged', 'merged after review');
    kicks = [];
    await svc.scanOverdue();
    assert.deepEqual(kicks, [], 'a decided watch is never rescanned');
  });
});
