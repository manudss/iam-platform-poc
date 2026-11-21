import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowTasksService } from './tasks.js';
import { WorkflowsIgaService } from './iga.service.js';
import type { TaskRow } from './store.js';

const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
const mkTask = (over: Partial<TaskRow>): TaskRow => ({
  id: 'task-1', tenant: 'acme', kind: 'approval', title: 't', detail: {}, assignee: 'boss', delegated_to: null,
  status: 'open', decision: null, justification: null, decided_by: null, run_id: 'run-1', node_id: 'n1',
  prevent_self: true, created_at: now(), due_at: null, reminded_at: null, decided_at: null, ...over,
});

const fakeStore = (over: Record<string, unknown> = {}) => ({
  putTask: async (t: TaskRow) => t,
  getTask: async (id: string) => tasks.get(id) ?? null,
  listTasks: async () => [...tasks.values()],
  decideTask: async (id: string, actor: string, decision: string, just: string | null, at: string) => { const t = tasks.get(id); if (!t || t.status !== 'open' || (t.assignee !== actor && t.delegated_to !== actor)) return null; Object.assign(t, { status: 'decided', decision, justification: just, decided_by: actor, decided_at: at }); return t; },
  decideTaskAs: async (id: string, actor: string, decision: string, just: string | null, at: string) => { const t = tasks.get(id); if (!t || t.status !== 'open') return null; Object.assign(t, { status: 'decided', decision, justification: just, decided_by: actor, decided_at: at }); return t; },
  delegateTask: async (id: string, to: string, at: string) => { const t = tasks.get(id); if (!t || t.status !== 'open') return null; Object.assign(t, { delegated_to: to, due_at: at, reminded_at: null }); return t; },
  markTaskReminded: async (id: string, at: string) => { const t = tasks.get(id); if (t) t.reminded_at = at; },
  cancelTasksForRun: async () => 0,
  getRun: async (_t: string, id: string) => runs.get(id) ?? null,
  getRunById: async (id: string) => runs.get(id) ?? null,
  listDueTasks: async (at: string) => [...tasks.values()].filter((t) => t.status === 'open' && t.due_at && t.due_at <= at && !t.reminded_at),
  ...over,
});
let tasks = new Map<string, TaskRow>();
let runs = new Map<string, { id: string; started_by: string }>();
const svc = (over: Record<string, unknown> = {}) => {
  const kicks: string[] = [];
  return { s: new WorkflowTasksService(fakeStore(over) as never, undefined, { get: () => ({ kick: (id: string) => kicks.push(id) }) } as never), kicks };
};

describe('WorkflowTasksService (real service, in-memory store)', () => {
  it('a decision resumes the awaiting run (kick on the task run id, IGA reviews included)', async () => {
    tasks = new Map([['task-1', mkTask({ run_id: 'run-42' })]]);
    runs = new Map([['run-42', { id: 'run-42', started_by: 'alice' }]]);
    const { s, kicks } = svc();
    await s.decide('acme', 'task-1', 'boss', 'approved', '');
    assert.deepEqual(kicks, ['run-42']);
    await assert.rejects(s.decide('acme', 'task-1', 'boss', 'approved', ''), /already decided/);
  });
  it('anti-self-approval follows the starter chain through sub-workflows', async () => {
    tasks = new Map([['task-1', mkTask({ run_id: 'run-child' })]]);
    runs = new Map([
      ['run-child', { id: 'run-child', started_by: 'workflow:run-parent' }],
      ['run-parent', { id: 'run-parent', started_by: 'alice' }],
    ]);
    const { s } = svc();
    await assert.rejects(s.decide('acme', 'task-1', 'alice', 'approved', ''), /anti-self-approval/);
    const decided = await s.decide('acme', 'task-1', 'boss', 'approved', '');
    assert.equal(decided.status, 'decided');
  });
  it('a refusal requires a justification', async () => {
    tasks = new Map([['task-1', mkTask({})]]);
    runs = new Map([['run-1', { id: 'run-1', started_by: 'alice' }]]);
    const { s } = svc();
    await assert.rejects(s.decide('acme', 'task-1', 'boss', 'refused', ''), /justification/);
  });
  it('the overdue scan is platform-wide: due tasks of every tenant escalate once and kick their run', async () => {
    const past = '2020-01-01 00:00:00.000';
    tasks = new Map([
      ['t1', mkTask({ id: 't1', tenant: 'acme', due_at: past, detail: { escalateTo: 'iga' }, run_id: 'run-1' })],
      ['t2', mkTask({ id: 't2', tenant: 'other', due_at: past, run_id: 'run-2' })],
      ['t3', mkTask({ id: 't3', tenant: 'acme', due_at: null })],
    ]);
    const { s, kicks } = svc();
    assert.equal(await s.scanOverdue(), 2);
    assert.equal(tasks.get('t1')!.delegated_to, 'iga');
    assert.deepEqual(kicks.sort(), ['run-1', 'run-2']);
    assert.equal(await s.scanOverdue(), 0, 'reminded once only');
  });
});

describe('WorkflowsIgaService review tasks carry the awaiting run id', () => {
  it('openReviewTasks records the workflow run id so a decision kicks the awaiting run', async () => {
    const created: Record<string, unknown>[] = [];
    const tasksSvc = { request: async (a: Record<string, unknown>) => { created.push(a); return { id: 'task-1', ...a }; } };
    const store = { igaGetCampaign: async () => ({ id: 'iga-1', tenant: 'acme', status: 'open' }), igaListItems: async () => [{ id: 'item-1', tenant: 'acme', campaign_id: 'iga-1', identity: 'emp', kind: 'user-access', action: 'review', payload: {}, state: 'pending', decided_by: null, decided_at: null, decision_reason: null, run_id: null }] };
    const iga = new WorkflowsIgaService(store as never, tasksSvc as never);
    await iga.openReviewTasks('acme', 'workflow:run-9', 'iga-1', { assignTo: 'manager', runId: 'run-9' });
    assert.equal(created[0].runId, 'run-9');
    assert.equal((created[0].detail as Record<string, unknown>).campaignId, 'iga-1');
  });
});
