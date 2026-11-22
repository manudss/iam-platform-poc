import 'reflect-metadata';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowsIgaService } from './iga.service.js';
import { WorkflowTasksService } from './tasks.js';

// Review deadline, single escalation, absent-validator replacement and late-review read.
// REAL: WorkflowTasksService + WorkflowsIgaService logic. DOUBLES: the store (in memory) and the reads.
// No real Dolt here: the tasks table itself is covered by the Dolt specs.
function setup(opts: { managerLogin?: boolean | 'unknown' } = {}) {
  const tasks = new Map<string, Record<string, any>>();
  const events: { name: string; p: any }[] = [];
  const store: any = {
    igaGetCampaign: async () => ({ id: 'iga-1', tenant: 'acme', kind: 'user-access', name: 'Q4', ref: 'main', status: 'open', scope: {}, created_by: 'a', created_at: 'now', closed_by: null, closed_at: null, evidence: null }),
    igaListItems: async () => [
      { id: 'item-1', tenant: 'acme', campaign_id: 'iga-1', identity: 'emp', kind: 'user-access', action: 'review', state: 'pending', payload: { roles: ['r1'], manager: 'boss' } },
      { id: 'item-2', tenant: 'acme', campaign_id: 'iga-1', identity: 'boss2', kind: 'user-access', action: 'review', state: 'pending', payload: { roles: ['r2'], manager: 'boss' } },
    ],
    listTasks: async (_t: string, q: { runId?: string }) => [...tasks.values()].filter((t) => !q.runId || t.run_id === q.runId),
    listTasksByCampaign: async () => [...tasks.values()],
    putTask: async (t: any) => { tasks.set(t.id, t); return t; },
    getTask: async (id: string) => tasks.get(id) ?? null,
    patchTaskDetail: async (id: string, patch: Record<string, unknown>) => { const t = tasks.get(id)!; for (const [k, v] of Object.entries(patch)) { if (v === null) delete t.detail[k]; else t.detail[k] = v; } },
    delegateTask: async (id: string, to: string, at: string) => { const t = tasks.get(id); if (!t || t.status !== 'open') return null; t.delegated_to = to; t.due_at = at; return t; },
  };
  const bus: any = { emit: (e: { type: string; payload: any }) => events.push({ name: e.type, p: e.payload }) };
  const taskSvc = new WorkflowTasksService(store, bus);
  const reads: any = { readUser: async (_t: string, _r: string, id: string) => { if (opts.managerLogin === 'unknown' && id === 'boss') throw new Error('unknown identity'); return { id, loginEnabled: opts.managerLogin === false && id === 'boss' ? false : true }; } };
  const iga = new WorkflowsIgaService(store, taskSvc as never, reads, undefined);
  return { iga, taskSvc, tasks, events };
}
const env = { ...process.env };
beforeEach(() => { process.env.IAM_API_ADMIN_SUBJECTS = 'adm1'; process.env.IAM_API_IGA_SUBJECTS = 'igaowner'; });
afterEach(() => { process.env = { ...env }; });

describe('iga review deadline and escalation', () => {
  it('without a deadline nothing changes: no due date, no escalation target', async () => {
    const { iga, tasks } = setup();
    await iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager' });
    for (const t of tasks.values()) { assert.equal(t.due_at, null); assert.equal(t.detail.escalateTo, undefined); }
  });
  it('dueInDays and escalateTo reach every task', async () => {
    const { iga, tasks } = setup();
    const r = await iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager', dueInDays: 5, escalateTo: 'iga' });
    assert.equal(r.opened, 2);
    for (const t of tasks.values()) {
      assert.equal(t.detail.escalateTo, 'iga');
      const days = (Date.parse(String(t.due_at).replace(' ', 'T') + 'Z') - Date.now()) / 86400000;
      assert.ok(days > 4.9 && days < 5.1, `due in ~5 days, got ${days}`);
    }
  });
  it('invalid input is refused before any task exists', async () => {
    for (const input of [{ dueInDays: 0, escalateTo: 'iga' }, { dueInDays: 91 }, { dueInDays: 'x' }, { dueInDays: -1 }, { dueInDays: 3, escalateTo: 'Bad Id!' }]) {
      const { iga, tasks } = setup();
      await assert.rejects(iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager', ...input }));
      assert.equal(tasks.size, 0);
    }
  });
  it('an absent manager (login disabled or unknown) sends the task to the iga pool and says so', async () => {
    for (const managerLogin of [false, 'unknown'] as const) {
      const { iga, tasks } = setup({ managerLogin });
      const r = await iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager' });
      assert.ok(r.tasks.every((t) => t.assignee === 'igaowner' && t.managerAbsent === true));
      assert.ok([...tasks.values()].every((t) => t.detail.managerAbsent === 'boss'));
    }
    const ok = setup();
    const r2 = await ok.iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager' });
    assert.ok(r2.tasks.every((t) => t.assignee === 'boss' && !t.managerAbsent));
  });
});

describe('iga late reviews and validator replacement', () => {
  it('overdueReviews lists only open, past-due review tasks, and changes nothing', async () => {
    const { iga, tasks } = setup();
    await iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager', dueInDays: 1 });
    assert.equal((await iga.overdueReviews('acme', 'iga-1')).overdue, 0);
    const [a, b] = [...tasks.values()];
    a.due_at = '2020-01-01 00:00:00.000'; b.due_at = '2020-01-01 00:00:00.000'; b.status = 'decided';
    const before = JSON.stringify([...tasks.values()]);
    const late = await iga.overdueReviews('acme', 'iga-1');
    assert.equal(late.overdue, 1);
    assert.equal(late.tasks[0].task, a.id);
    assert.equal(late.tasks[0].assignee, 'boss');
    assert.equal(JSON.stringify([...tasks.values()]), before, 'read only: no revocation, no decision, no state change');
  });
  it('reassign moves only OPEN tasks of the absent validator, keeps the deadline, records the origin', async () => {
    const { iga, tasks, events } = setup();
    await iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager', dueInDays: 3 });
    const [a, b] = [...tasks.values()];
    b.status = 'decided';
    const due = a.due_at;
    const r = await iga.reassignReviewTasks('acme', 'workflow:r', 'iga-1', { from: 'boss', to: 'iga', reason: 'on leave' });
    assert.deepEqual(r.reassigned, [a.id]);
    assert.equal(a.delegated_to, 'igaowner');
    assert.equal(a.due_at, due);
    assert.equal(a.detail.reassignedFrom, 'boss');
    assert.equal(b.delegated_to ?? null, null, 'a decided task is untouched');
    assert.equal(a.status, 'open', 'no automatic decision');
    assert.ok(events.some((e) => e.name === 'workflow.task-assigned'));
  });
  it('a replacement who is the person under review is refused and reported, not skipped', async () => {
    const { iga, tasks } = setup();
    await iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager' });
    const r = await iga.reassignReviewTasks('acme', 'workflow:r', 'iga-1', { from: 'boss', to: 'emp' });
    assert.equal(r.reassigned.length, 1);
    assert.equal(r.refused.length, 1);
    assert.match(r.refused[0].reason, /person this task is about/);
    assert.ok([...tasks.values()].some((t) => t.identity === undefined && t.detail.identity === 'emp' && (t.delegated_to ?? t.assignee) === 'boss'));
  });
  it('bad input: same from/to, missing ids, unknown pool', async () => {
    const { iga } = setup();
    await assert.rejects(iga.reassignReviewTasks('acme', 'a', 'iga-1', { from: 'x', to: 'x' }));
    await assert.rejects(iga.reassignReviewTasks('acme', 'a', 'iga-1', { from: '', to: 'x' }));
    process.env.IAM_API_ADMIN_SUBJECTS = ''; process.env.IAM_API_IGA_SUBJECTS = '';
    await assert.rejects(iga.reassignReviewTasks('acme', 'a', 'iga-1', { from: 'x', to: 'iga' }), /pool is empty/);
  });
});
