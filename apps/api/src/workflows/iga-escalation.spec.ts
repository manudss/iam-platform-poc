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
    getRunById: async () => null,
    decideTaskAs: async (id: string, actor: string, d: string, j: string | null, at: string) => { const t = tasks.get(id)!; t.status = 'decided'; t.decision = d; t.decided_by = actor; t.justification = j; t.decided_at = at; return t; },
    listDueTasks: async () => [...tasks.values()].filter((t) => t.status === 'open' && t.due_at && (!t.reminded_at)),
    markTaskReminded: async (id: string, at: string) => { tasks.get(id)!.reminded_at = at; },
    delegateTask: async (id: string, to: string, at: string) => { const t = tasks.get(id); if (!t || t.status !== 'open') return null; t.delegated_to = to; t.due_at = at; return t; },
  };
  const bus: any = { emit: (e: { type: string; payload: any }) => events.push({ name: e.type, p: e.payload }) };
  const taskSvc = new WorkflowTasksService(store, bus);
  const kicks: string[] = [];
  (taskSvc as any).kick = (id: string) => kicks.push(id);
  const reads: any = { readUser: async (_t: string, _r: string, id: string) => { if (opts.managerLogin === 'unknown' && id === 'boss') throw new Error('unknown identity'); return { id, loginEnabled: opts.managerLogin === false && id === 'boss' ? false : true }; } };
  const iga = new WorkflowsIgaService(store, taskSvc as never, reads, undefined);
  return { iga, taskSvc, tasks, events, kicks };
}
const env = { ...process.env };
beforeEach(() => { process.env.IAM_API_ADMIN_SUBJECTS = 'adm1'; process.env.IAM_API_IGA_SUBJECTS = 'igaowner,emp'; });
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
    const r = await iga.reassignReviewTasks('acme', 'workflow:r', 'iga-1', { from: 'boss', to: 'iga', reason: 'on leave', startedBy: 'adm1' });
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
    const r = await iga.reassignReviewTasks('acme', 'workflow:r', 'iga-1', { from: 'boss', to: 'emp', startedBy: 'adm1' });
    assert.equal(r.reassigned.length, 1);
    assert.equal(r.refused.length, 1);
    assert.match(r.refused[0].reason, /person this task is about/);
    assert.ok([...tasks.values()].some((t) => t.identity === undefined && t.detail.identity === 'emp' && (t.delegated_to ?? t.assignee) === 'boss'));
  });
  it('bad input: same from/to, missing ids, unknown pool', async () => {
    const { iga } = setup();
    await assert.rejects(iga.reassignReviewTasks('acme', 'a', 'iga-1', { from: 'x', to: 'x', startedBy: 'adm1' }));
    await assert.rejects(iga.reassignReviewTasks('acme', 'a', 'iga-1', { from: '', to: 'x', startedBy: 'adm1' }));
    process.env.IAM_API_ADMIN_SUBJECTS = ''; process.env.IAM_API_IGA_SUBJECTS = '';
    await assert.rejects(iga.reassignReviewTasks('acme', 'a', 'iga-1', { from: 'x', to: 'iga', startedBy: 'adm1' }), /only an admin or an IGA pool member|pool is empty/);
  });
});

describe('iga reassignment authority and escalation safety', () => {
  it('a run NOT started by an admin or IGA pool member cannot move reviews: nothing is touched', async () => {
    const { iga, tasks } = setup();
    await iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager' });
    const before = JSON.stringify([...tasks.values()]);
    for (const startedBy of [undefined, 'someone', 'boss', 'workflow:other']) {
      await assert.rejects(iga.reassignReviewTasks('acme', 'workflow:r', 'iga-1', { from: 'boss', to: 'iga', startedBy }), /only an admin or an IGA pool member/);
    }
    assert.equal(JSON.stringify([...tasks.values()]), before);
  });
  it('the replacement must be in the admin or IGA pool: an accomplice id is refused, even from an admin starter', async () => {
    const { iga, tasks } = setup();
    await iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager' });
    await assert.rejects(iga.reassignReviewTasks('acme', 'workflow:r', 'iga-1', { from: 'boss', to: 'friend', startedBy: 'adm1' }), /member of the admin or IGA pool/);
    assert.ok([...tasks.values()].every((t) => t.delegated_to == null));
    const ok = await iga.reassignReviewTasks('acme', 'workflow:r', 'iga-1', { from: 'boss', to: 'igaowner', startedBy: 'igaowner' });
    assert.equal(ok.reassigned.length, 2);
  });
  it('escalateTo must be iga, admin or a pool member', async () => {
    const { iga, tasks } = setup();
    await assert.rejects(iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager', dueInDays: 2, escalateTo: 'friend' }), /pool/);
    assert.equal(tasks.size, 0);
  });
  it('a manager read FAILURE is not an absence: the step stops, no task is filed under a false reason', async () => {
    const { iga, tasks } = setup();
    (iga as any).readsRef = { readUser: async () => { throw new Error('connection reset'); } };
    await assert.rejects(iga.openReviewTasks('acme', 'workflow:r', 'iga-1', { assignTo: 'manager' }), /read failed/);
    assert.equal(tasks.size, 0);
  });
  it('campaign scenario: late review escalates ONCE, never to the reviewed person, the new decider decides, the run is kicked, nothing is revoked', async () => {
    const { iga, taskSvc, tasks, kicks } = setup();
    await iga.openReviewTasks('acme', 'workflow:run-7', 'iga-1', { assignTo: 'manager', dueInDays: 1, escalateTo: 'iga', runId: 'run-7' });
    assert.equal(await taskSvc.scanOverdue(), 0, 'not due yet');
    for (const t of tasks.values()) t.due_at = '2020-01-01 00:00:00.000';
    assert.equal(await taskSvc.scanOverdue(), 2);
    for (const t of tasks.values()) { assert.equal(t.delegated_to, 'igaowner'); assert.ok(t.reminded_at); assert.equal(t.status, 'open'); }
    assert.deepEqual(kicks, ['run-7', 'run-7']);
    assert.equal(await taskSvc.scanOverdue(), 0, 'escalation happens once');
    const [a] = [...tasks.values()];
    const done = await taskSvc.decide('acme', a.id, 'igaowner', 'denied', 'no longer needed');
    assert.equal(done.status, 'decided'); assert.equal(done.decided_by, 'igaowner');
    assert.equal((await iga.overdueReviews('acme', 'iga-1')).overdue, 1, 'the undecided one stays visible as late');
  });
  it('an escalation that would land on the person under review goes to another pool member, or the task stays', async () => {
    const { iga, taskSvc, tasks } = setup();
    process.env.IAM_API_IGA_SUBJECTS = 'emp,igaowner';
    await iga.openReviewTasks('acme', 'workflow:run-7', 'iga-1', { assignTo: 'manager', dueInDays: 1, escalateTo: 'iga', runId: 'run-7' });
    for (const t of tasks.values()) { t.due_at = '2020-01-01 00:00:00.000'; if (t.detail.identity === 'emp') t.assignee = 'boss'; }
    await taskSvc.scanOverdue();
    const emp = [...tasks.values()].find((t) => t.detail.identity === 'emp')!;
    assert.notEqual(emp.delegated_to, 'emp');
    process.env.IAM_API_IGA_SUBJECTS = 'emp'; process.env.IAM_API_ADMIN_SUBJECTS = 'emp';
    const { iga: i2, taskSvc: s2, tasks: t2 } = setup();
    process.env.IAM_API_IGA_SUBJECTS = 'igaowner,emp'; process.env.IAM_API_ADMIN_SUBJECTS = 'adm1';
    await i2.openReviewTasks('acme', 'workflow:run-7', 'iga-1', { assignTo: 'manager', dueInDays: 1, escalateTo: 'iga', runId: 'run-7' });
    process.env.IAM_API_IGA_SUBJECTS = 'emp'; process.env.IAM_API_ADMIN_SUBJECTS = 'emp';
    for (const t of t2.values()) t.due_at = '2020-01-01 00:00:00.000';
    await s2.scanOverdue();
    const stay = [...t2.values()].find((t) => t.detail.identity === 'emp')!;
    assert.notEqual(stay.delegated_to, 'emp', 'never escalated onto the reviewed person');
  });
});

describe('iga: access changed after the campaign launched (acceptance criterion)', () => {
  const build = (current: string[]) => {
    const updates: { id: string; patch: Record<string, any> }[] = [];
    const store: any = {
      igaGetCampaign: async () => ({ id: 'iga-1', tenant: 'acme', kind: 'user-access', name: 'Q4', ref: 'main', status: 'open', scope: {}, created_by: 'a', created_at: 'now', closed_by: null, closed_at: null, evidence: null }),
      igaListItems: async () => [{ id: 'item-1', tenant: 'acme', campaign_id: 'iga-1', identity: 'emp', kind: 'user-access', action: 'review', state: 'denied', payload: { roles: ['r1', 'r2'] } }],
      igaUpdateItem: async (id: string, patch: Record<string, any>) => { updates.push({ id, patch }); return true; },
    };
    const reads: any = { listAssignments: async () => ({ assignments: current.map((role) => ({ identity: 'emp', role })) }) };
    return { iga: new WorkflowsIgaService(store, undefined, reads, undefined), updates };
  };
  it('unchanged roles: the revocation is prepared', async () => {
    const { iga, updates } = build(['r1', 'r2']);
    const r = await iga.prepareRemediation('acme', 'workflow:r', 'iga-1', {});
    assert.equal(r.remediation[0].actions?.length, 2);
    assert.equal(updates[0].patch.state, 'remediation-prepared');
  });
  it('a role added, or removed by someone else, after launch: conflict reported, nothing prepared, no state change', async () => {
    for (const current of [['r1', 'r2', 'r3'], ['r1'], []]) {
      const { iga, updates } = build(current);
      const r = await iga.prepareRemediation('acme', 'workflow:r', 'iga-1', {});
      assert.match(String(r.remediation[0].conflict), /roles changed since the snapshot/);
      assert.equal(r.remediation[0].actions, undefined);
      assert.equal(updates.length, 0);
    }
  });
});
