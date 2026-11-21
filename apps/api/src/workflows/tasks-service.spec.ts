import 'reflect-metadata';
process.env.IAM_API_ADMIN_SUBJECTS = 'root';
process.env.IAM_API_IGA_SUBJECTS = 'iga-lead,iga-two';
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
  patchTaskDetail: async (id: string, patch: Record<string, unknown>) => { const t = tasks.get(id); if (!t) return; const d = { ...(t.detail ?? {}) } as Record<string, unknown>; for (const [k, v] of Object.entries(patch)) { if (v === null) delete d[k]; else d[k] = v; } t.detail = d; },
  countRunsStartedBy: async () => 0,
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
  it('every pool member decides (atomic), the beneficiary and the starter never do', async () => {
    tasks = new Map([['task-1', mkTask({ assignee: 'iga-lead', detail: { pool: 'iga', identity: 'emp', decisions: ['approved', 'refused'] } })]]);
    runs = new Map([['run-1', { id: 'run-1', started_by: 'alice' }]]);
    const { s } = svc();
    await assert.rejects(s.decide('acme', 'task-1', 'emp', 'approved', ''), /beneficiary/);
    await assert.rejects(s.decide('acme', 'task-1', 'alice', 'approved', ''), /anti-self-approval/);
    await assert.rejects(s.decide('acme', 'task-1', 'outsider', 'approved', ''), /pool/);
    const decided = await s.decide('acme', 'task-1', 'iga-two', 'approved', '');
    assert.equal(decided.status, 'decided');
    assert.equal(decided.decided_by, 'iga-two', 'the second pool member decided, not only the first');
    await assert.rejects(s.decide('acme', 'task-1', 'iga-lead', 'approved', ''), /already decided/);
  });
  it('a pool member delegates, the pool policy follows a pool target', async () => {
    tasks = new Map([['task-1', mkTask({ assignee: 'iga-lead', detail: { pool: 'iga' } })]]);
    const { s } = svc();
    await assert.rejects(s.delegate('acme', 'task-1', 'outsider', 'carol'), /pool member/);
    const d = await s.delegate('acme', 'task-1', 'iga-two', 'admin');
    assert.equal(d.delegated_to, 'root', 'the "admin" delegation target resolves through the pool policy');
    assert.equal(tasks.get('task-1')!.detail?.pool, 'admin');
  });
  it('tenant isolation: a task of another tenant is not found (decide, delegate)', async () => {
    tasks = new Map([['task-1', mkTask({ tenant: 'acme' })]]);
    const { s } = svc();
    await assert.rejects(s.decide('globex', 'task-1', 'boss', 'approved', ''), /unknown task/);
    await assert.rejects(s.delegate('globex', 'task-1', 'boss', 'carol'), /unknown task/);
    const still = await s.decide('acme', 'task-1', 'boss', 'approved', '');
    assert.equal(still.status, 'decided');
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
    assert.equal(tasks.get('t1')!.delegated_to, 'iga-lead', 'the "iga" escalation alias resolves through the pool policy');
    assert.equal(tasks.get('t1')!.detail?.pool, 'iga', 'the pool policy follows the escalation');
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

describe('WorkflowsIgaService.markRemediated: effective proof, never a state flip on trust', () => {
  const item = { id: 'item-1', tenant: 'acme', campaign_id: 'iga-1', identity: 'emp', kind: 'user-access', action: 'review', payload: { roles: ['role-a'] }, state: 'remediation-prepared', decided_by: null, decided_at: null, decision_reason: null, run_id: null };
  const mkIga = (run: unknown, onRef: string[], onBranch: string[]) => {
    const updated: Record<string, unknown>[] = [];
    const store = {
      igaGetCampaign: async () => ({ id: 'iga-1', tenant: 'acme', status: 'open', ref: 'main' }),
      igaListItems: async () => [item],
      getRun: async () => run,
      igaUpdateItem: async (_id: string, patch: Record<string, unknown>) => { updated.push(patch); },
    };
    const reads = { listAssignments: async (ref: string, f: { identity?: string }) => ({ assignments: (ref === 'main' ? onRef : onBranch).map((role) => ({ identity: f.identity, role })) }) };
    return { iga: new WorkflowsIgaService(store as never, undefined, reads as never), updated };
  };
  it('refuses without a completed proof run, or while the role is still assigned on the campaign ref', async () => {
    let x = mkIga(null, [], []);
    await assert.rejects(x.iga.markRemediated('acme', 'workflow:run-1', 'iga-1', 'item-1', { runId: 'run-9' }), /unknown run/);
    x = mkIga({ id: 'run-9', status: 'running', branch: 'wf-run-9' }, [], []);
    await assert.rejects(x.iga.markRemediated('acme', 'workflow:run-1', 'iga-1', 'item-1', { runId: 'run-9' }), /not completed/);
    x = mkIga({ id: 'run-9', status: 'completed', branch: 'wf-run-9' }, ['role-a'], ['role-a']);
    await assert.rejects(x.iga.markRemediated('acme', 'workflow:run-1', 'iga-1', 'item-1', { runId: 'run-9' }), /not effective/);
    assert.equal(x.updated.length, 0, 'no state flip while the assignment is still there');
  });
  it('distinguishes revoked-on-branch from published, and marks remediated only once effective on the ref', async () => {
    let x = mkIga({ id: 'run-9', status: 'completed', branch: 'wf-run-9' }, ['role-a'], []);
    await assert.rejects(x.iga.markRemediated('acme', 'workflow:run-1', 'iga-1', 'item-1', { runId: 'run-9' }), /not published to main: publish it/);
    x = mkIga({ id: 'run-9', status: 'completed', branch: 'wf-run-9' }, [], []);
    const r = await x.iga.markRemediated('acme', 'workflow:run-1', 'iga-1', 'item-1', { runId: 'run-9', note: 'revoked' });
    assert.equal(r.state, 'remediated');
    const proof = (x.updated[0].payload as Record<string, unknown>).remediationProof as Record<string, unknown>;
    assert.equal(proof.runId, 'run-9');
    assert.equal(proof.verifiedOn, 'main', 'the evidence records the ref the verification read');
  });
  it('a note alone never suffices', async () => {
    const x = mkIga({ id: 'run-9', status: 'completed', branch: null }, [], []);
    await assert.rejects(x.iga.markRemediated('acme', 'workflow:run-1', 'iga-1', 'item-1', { note: 'done, trust me' }), /required/);
  });
});
