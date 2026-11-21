import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { externalBlock, type WfBlockCtx } from './model.js';

const run1 = async (t: string, c: never): Promise<Record<string, never> & Record<string, unknown>> => (await externalBlock(t)!.run(c)) as never;
const mk = (over: Partial<WfBlockCtx>) => { const lines: string[] = []; return { c: { tenant: 'acme', config: {}, settings: {}, dryRun: false, log: (l: string) => lines.push(l), outputs: {}, branchWrite: async () => undefined, runId: 'run-1', baseBranch: 'main', ...over } as WfBlockCtx, lines }; };

/** In-memory durable-task service shaped like WorkflowTasksService. */
const fakeTasks = (decide?: { decision: string; by: string; justification?: string }) => {
  const tasks = new Map<string, Record<string, unknown>>();
  let n = 0;
  return {
    tasks,
    request: async (a: Record<string, unknown>) => { const t = { id: `task-${++n}`, status: 'open', ...a }; tasks.set(t.id, t); return t; },
    check: async (_tenant: string, id: string) => {
      const t = tasks.get(id);
      if (!t) return { state: 'decided', task: { id } };
      if (t.status === 'decided' || t.status === 'canceled') return { state: 'decided', task: t };
      if (decide) { t.status = 'decided'; t.decision = decide.decision; t.decided_by = decide.by; t.justification = decide.justification ?? null; return { state: 'decided', task: t }; }
      return { state: 'open', task: t };
    },
    inbox: async () => ({ tasks: [...tasks.values()] }),
    decide: async (_t: string, id: string, actor: string, decision: string, justification: string) => { const t = tasks.get(id)!; t.status = 'decided'; t.decision = decision; t.decided_by = actor; t.justification = justification; return t; },
  };
};

describe('workflow blocks: lyam-request-approval (durable human task)', () => {
  it('validates its fields', () => {
    const b = externalBlock('lyam-request-approval')!;
    assert.throws(() => b.validate({ title: '', assignee: 'admin' }), /required/);
    assert.throws(() => b.validate({ title: 'x', assignee: 'admin', decisions: 'ok,NOT OK!' }), /decisions/);
    assert.deepEqual(b.validate({ title: 'Access', assignee: 'manager', subject: 'emp', decisions: '' }).decisions, ['approved', 'refused']);
  });
  it('creates a task and suspends; resumes with the recorded decision', async () => {
    const svc = fakeTasks({ decision: 'approved', by: 'boss' });
    const b = externalBlock('lyam-request-approval')!;
    const { c } = mk({ tasks: svc as never, reads: { readUser: async () => ({ manager: 'boss' }) } as never, config: { title: 'Access for emp', kind: 'approval', assignee: 'manager', subject: 'emp', decisions: ['approved', 'refused'], context: {} } });
    await assert.rejects(b.run(c), /waiting for approval/);
    const taskId = [...svc.tasks.keys()][0];
    assert.equal(svc.tasks.get(taskId)!.assignee, 'boss');
    assert.equal(svc.tasks.get(taskId)!.preventSelfApproval, true);
    const out = await b.run(mk({ tasks: svc as never, config: c.config, resumeWait: { taskId } } as never).c);
    assert.deepEqual(out, { taskId, decision: 'approved', decidedBy: 'boss', justification: '' });
  });
  it('still open: suspends again; canceled: fails honestly', async () => {
    const svc = fakeTasks();
    const b = externalBlock('lyam-request-approval')!;
    const { c } = mk({ tasks: svc as never, config: { title: 'x', kind: 'approval', assignee: 'admin', decisions: ['approved', 'refused'], context: {} } });
    await assert.rejects(b.run(c), /waiting/);
    const taskId = [...svc.tasks.keys()][0];
    await assert.rejects(b.run(mk({ tasks: svc as never, config: c.config, resumeWait: { taskId } } as never).c), /waiting/);
    svc.tasks.get(taskId)!.status = 'canceled';
    await assert.rejects(b.run(mk({ tasks: svc as never, config: c.config, resumeWait: { taskId } } as never).c), /canceled/);
  });
  it('a test run opens nothing', async () => {
    const svc = fakeTasks();
    const { c, lines } = mk({ test: true, tasks: svc as never, config: { title: 'x', kind: 'approval', assignee: 'admin', decisions: ['approved'], context: {} } });
    assert.equal((await externalBlock('lyam-request-approval')!.run(c))!.decision, 'approved');
    assert.equal(svc.tasks.size, 0); assert.match(lines[0], /would open/);
  });
});

describe('workflow blocks: reads and simulation', () => {
  it('lyam-read-user reads on the base ref by default', async () => {
    const refs: string[] = [];
    const reads = { readUser: async (_t: string, ref: string, id: string) => { refs.push(ref); return { id, displayName: 'E', roles: [] }; } };
    const { c } = mk({ reads: reads as never, config: { id: 'emp' } });
    assert.equal((await externalBlock('lyam-read-user')!.run(c))!.id, 'emp');
    assert.deepEqual(refs, ['main']);
    await externalBlock('lyam-read-user')!.run(mk({ reads: reads as never, runBranch: 'wf/x', config: { id: 'emp', ref: 'run' } } as never).c);
    assert.deepEqual(refs, ['main', 'wf/x']);
  });
  it('lyam-simulate-assignment returns the computed conflicts', async () => {
    const reads = { simulateAssignments: async () => ({ changes: { granted: 1, revoked: 0 }, conflicts: [{ identity: 'emp', roleA: 'a', roleB: 'b' }], conflictsCount: 1 }) };
    const { c } = mk({ reads: reads as never, config: { grant: [{ identity: 'emp', role: 'a' }], revoke: [] } });
    assert.equal((await externalBlock('lyam-simulate-assignment')!.run(c))!.conflictsCount, 1);
    await assert.rejects(externalBlock('lyam-simulate-assignment')!.run(mk({ reads: reads as never, config: { grant: [{ identity: 'BAD ID!', role: 'a' }], revoke: [] } }).c), /identity/);
  });
  it('a read without the reads service refuses instead of pretending', async () => {
    await assert.rejects(externalBlock('lyam-list-roles')!.run(mk({ config: {} }).c), /not available/);
  });
});

describe('workflow blocks: lifecycle and roles writes (run branch)', () => {
  it('lyam-update-user writes on the run branch only, never in a test run', async () => {
    const queries: string[] = [];
    const branchWrite = (async (fn: (db: { query: (q: string, v?: unknown[]) => Promise<[unknown, unknown]> }) => Promise<void>) => fn({ query: async (q: string) => { queries.push(q); return [{ affectedRows: 1 }, null] as [unknown, unknown]; } })) as never;
    const b = externalBlock('lyam-update-user')!;
    assert.equal((await b.run(mk({ test: true, branchWrite, config: { id: 'emp', department: 'it' } }).c))!.updated, false);
    assert.equal(queries.length, 0);
    assert.equal((await b.run(mk({ branchWrite, config: { id: 'emp', department: 'it' } }).c))!.updated, true);
    assert.match(queries[0], /update identities set department = \?/);
    await assert.rejects(b.run(mk({ branchWrite, config: { id: 'emp' } }).c), /at least one attribute/);
  });
});

describe('workflow blocks: IGA recertification socle', () => {
  const fakeIga = () => {
    const calls: string[] = [];
    return {
      calls,
      createCampaign: async () => { calls.push('create'); return { id: 'iga-1', name: 'Q4', status: 'open' }; },
      listItems: async () => { calls.push('list'); return { items: [{ id: 'item-1', identity: 'emp', state: 'pending' }] }; },
      openReviewTasks: async () => { calls.push('open'); return { campaign: 'iga-1', opened: 1, tasks: [{ item: 'item-1', task: 'task-1', assignee: 'boss' }] }; },
      recordTaskDecisions: async () => { calls.push('record'); return { recorded: [{ task: 'task-1', item: 'item-1', recorded: 'approved' }] }; },
      prepareRemediation: async () => { calls.push('prepare'); return { campaign: 'iga-1', remediation: [{ item: 'item-1', identity: 'emp', actions: [{ type: 'revoke-role', identity: 'emp', role: 'a' }] }] }; },
      close: async () => { calls.push('close'); return { campaign: 'iga-1', status: 'closed', evidence: { digest: 'abc123' } }; },
      getCampaign: async () => ({ id: 'iga-1', status: 'open' }),
    };
  };
  it('create/list/open/await/record/prepare/close go through the service, test runs stay dry', async () => {
    const iga = fakeIga();
    assert.equal((await run1('iga-create-campaign', mk({ iga: iga as never, config: { name: 'Q4', kind: 'user-access', ref: 'main', scope: {} } }).c as never)).id, 'iga-1');
    assert.equal(((await run1('iga-list-items', mk({ iga: iga as never, config: { campaignId: 'iga-1' } }).c as never)).items as unknown[]).length, 1);
    assert.equal((await run1('iga-open-review-tasks', mk({ iga: iga as never, config: { campaignId: 'iga-1', assignTo: 'manager' } }).c as never)).opened, 1);
    assert.equal(((await run1('iga-prepare-remediation', mk({ iga: iga as never, config: { campaignId: 'iga-1' } }).c as never)).remediation as { actions: unknown[] }[])[0].actions.length, 1);
    assert.equal((await run1('iga-close-campaign', mk({ iga: iga as never, config: { campaignId: 'iga-1' } }).c as never)).status, 'closed');
    assert.deepEqual(iga.calls, ['create', 'list', 'open', 'prepare', 'close']);
    assert.equal((await run1('iga-create-campaign', mk({ test: true, iga: iga as never, config: { name: 'Q4', kind: 'user-access', ref: 'main', scope: {} } }).c as never)).status, 'test');
  });
  it('iga-await-decisions suspends while a review is open, records once all decided, refuses with no task', async () => {
    const openTask: Record<string, unknown> = { id: 'task-1', kind: 'iga-review', status: 'open', detail: { campaignId: 'iga-1' } };
    const iga = { ...fakeIga(), reviewTasks: async () => ({ tasks: [openTask] }) };
    const b = externalBlock('iga-await-decisions')!;
    await assert.rejects(b.run(mk({ iga: iga as never, config: { campaignId: 'iga-1' } }).c), /waiting/);
    openTask.status = 'decided';
    const out = await run1('iga-await-decisions', mk({ iga: iga as never, config: { campaignId: 'iga-1' } }).c as never);
    assert.deepEqual(iga.calls, ['record']);
    assert.equal(out.open, 0);
    const empty = { ...fakeIga(), reviewTasks: async () => ({ tasks: [] }) };
    await assert.rejects(b.run(mk({ iga: empty as never, config: { campaignId: 'iga-1' } }).c), /no review task/);
  });
});

describe('workflow blocks: P2 proposals (never apply, always a human decision)', () => {
  it('lyam-propose-policy-change opens a task and suspends', async () => {
    const svc = fakeTasks({ decision: 'approved', by: 'admin' });
    const b = externalBlock('lyam-propose-policy-change')!;
    const { c } = mk({ tasks: svc as never, config: { title: 'MFA for all', detail: { proposal: { rule: 'mfa' } }, assignee: 'admin' } });
    await assert.rejects(b.run(c), /waiting/);
    const taskId = [...svc.tasks.keys()][0];
    assert.equal(svc.tasks.get(taskId)!.preventSelfApproval, true);
    assert.equal((await b.run(mk({ tasks: svc as never, config: c.config, resumeWait: { taskId } } as never).c))!.decision, 'approved');
  });
  it('lyam-validate-policy refuses without the policies service', async () => {
    await assert.rejects(externalBlock('lyam-validate-policy')!.run(mk({ config: { policy: '{}' } }).c), /not available/);
  });
});
