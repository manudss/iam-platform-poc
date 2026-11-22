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
  it('lyam-read-user / lyam-search-users: email and profile values are OPT-IN (minimal projection persisted by default)', async () => {
    const full = { id: 'emp', displayName: 'E', department: 'finance', manager: null, email: 'e@x.invalid', loginEnabled: true, roles: ['a'], profileFields: { badge: 'blue' } };
    const reads = { readUser: async () => ({ ...full, profileFields: { ...full.profileFields } }), listUsers: async () => ({ count: 1, users: [{ id: 'emp', displayName: 'E', department: 'finance', manager: null, email: 'e@x.invalid', loginEnabled: true }] }) };
    const bare = (await externalBlock('lyam-read-user')!.run(mk({ reads: reads as never, config: { id: 'emp' } }).c))!;
    assert.ok(!('email' in bare) && !('profileFields' in bare), 'default: no email, no profile values in the persisted step output');
    assert.deepEqual(Object.keys(bare).sort(), ['department', 'displayName', 'id', 'loginEnabled', 'manager', 'roles'].sort());
    const withPii = (await externalBlock('lyam-read-user')!.run(mk({ reads: reads as never, config: { id: 'emp', includeEmail: 'yes', includeProfile: 'yes' } }).c))!;
    assert.equal(withPii.email, 'e@x.invalid');
    assert.deepEqual(withPii.profileFields, { badge: 'blue' });
    const found = (await externalBlock('lyam-search-users')!.run(mk({ reads: reads as never, config: {} }).c))! as { users: Record<string, unknown>[] };
    assert.ok(!('email' in found.users[0]), 'search: no email by default');
    const foundPii = (await externalBlock('lyam-search-users')!.run(mk({ reads: reads as never, config: { includeEmail: 'yes' } }).c))! as { users: Record<string, unknown>[] };
    assert.equal(foundPii.users[0].email, 'e@x.invalid', 'search: email on explicit request only');
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

describe('workflow blocks: lyam-update-role', () => {
  const dbFor = (row: Record<string, unknown> | null, queries: { q: string; v?: unknown[] }[]) => (async (fn: (db: { query: (q: string, v?: unknown[]) => Promise<unknown> }) => Promise<void>) => fn({ query: async (q: string, v?: unknown[]) => { queries.push({ q, v }); return q.startsWith('select') ? [row ? [row] : []] : [{ affectedRows: 1 }]; } })) as never;
  it('validates: nothing to change, bad sensitivity', () => {
    const b = externalBlock('lyam-update-role')!;
    assert.throws(() => b.validate({ id: 'auditor' }), /nothing to change/);
    assert.throws(() => b.validate({ id: 'auditor', sensitive: 'maybe' }), /sensitive/);
  });
  it('test run writes nothing; real run updates label and sensitivity on the run branch', async () => {
    const b = externalBlock('lyam-update-role')!; const queries: { q: string; v?: unknown[] }[] = [];
    assert.equal((await b.run(mk({ test: true, branchWrite: dbFor({ id: 'auditor', is_sensitive: 0 }, queries), config: { id: 'auditor', label: 'Auditor', sensitive: 'yes' } }).c))!.updated, false);
    assert.equal(queries.length, 0);
    assert.equal((await b.run(mk({ branchWrite: dbFor({ id: 'auditor', is_sensitive: 0 }, queries), config: { id: 'auditor', label: 'Auditor', sensitive: 'yes' } }).c))!.updated, true);
    assert.match(queries[1].q, /update roles set label = \?, is_sensitive = 1 where id = \?/);
  });
  it('an unknown role is refused (never created) and a sensitive role is never downgraded', async () => {
    const b = externalBlock('lyam-update-role')!; const queries: { q: string; v?: unknown[] }[] = [];
    await assert.rejects(b.run(mk({ branchWrite: dbFor(null, queries), config: { id: 'ghost', label: 'X', sensitive: 'unchanged' } }).c), /unknown role/);
    await assert.rejects(b.run(mk({ branchWrite: dbFor({ id: 'admin', is_sensitive: 1 }, queries), config: { id: 'admin', sensitive: 'no' } }).c), /reviewed change/);
    assert.ok(queries.every((x) => x.q.startsWith('select')), 'no write was attempted');
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
  it('iga-close-campaign: strict close, incomplete closure only through a human exception', async () => {
    const closeCalls: unknown[] = [];
    const conflict = Object.assign(new Error('this campaign is not complete: 1 undecided item(s), 0 denied item(s)'), { getStatus: () => 409 });
    const iga = { ...fakeIga(), listItems: async () => ({ items: [{ id: 'item-1', identity: 'emp', state: 'pending' }] }), close: async (_t: string, _a: string, _c: string, input: unknown) => { closeCalls.push(input); if (!closeCalls.length || !((input as Record<string, unknown>).exception)) throw conflict; return { campaign: 'iga-1', status: 'closed', evidence: { digest: 'abc123' } }; } };
    const requested: Record<string, unknown>[] = [];
    const tasks = { check: async () => ({ state: 'decided', task: { id: 'task-9', status: 'decided', decision: 'approved', decided_by: 'iga-two', justification: 'accepted risk', detail: { unresolved: [{ item: 'item-1', identity: 'emp', state: 'pending' }] } } }), request: async (a: Record<string, unknown>) => { requested.push(a); return { id: 'task-9' }; } };
    const b = externalBlock('iga-close-campaign')!;
    await assert.rejects(b.run(mk({ iga: iga as never, tasks: tasks as never, config: { campaignId: 'iga-1' } }).c), /waiting/);
    assert.equal(requested[0].kind, 'iga-close-exception');
    assert.equal((requested[0].detail as Record<string, unknown[]>).unresolved.length, 1);
    const out = await run1('iga-close-campaign', mk({ iga: iga as never, tasks: tasks as never, config: { campaignId: 'iga-1' }, resumeWait: { taskId: 'task-9', kind: 'iga-close-campaign' } }).c as never);
    assert.equal(out.status, 'closed');
    assert.deepEqual(closeCalls[1], { exception: { by: 'iga-two', justification: 'accepted risk', approvedUnresolved: ['item-1'] } }, 'the evidence names the human who authorized the exception AND the exact unresolved set they approved');
  });
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

describe('workflow blocks: publication (lyam-read-diff, lyam-request-publish)', () => {
  it('lyam-read-diff needs a run branch and returns the publish diff', async () => {
    const publish = { diff: async (from: string, to: string) => ({ from, to, tables: [{ table: 'roles', adds: 1 }] }) };
    await assert.rejects(externalBlock('lyam-read-diff')!.run(mk({ publish: publish as never, runBranch: null }).c), /no data branch/);
    const out = await run1('lyam-read-diff', mk({ publish: publish as never, runBranch: 'wf-run-1' }).c as never);
    assert.deepEqual((out.diff as Record<string, unknown>).to, 'wf-run-1');
  });
  it('lyam-request-publish: await=no returns the PR; the wait follows the REAL PR state, never just the task', async () => {
    let prState = 'open';
    const publish = { request: async () => ({ pullRequest: { id: 7, source: 'wf-run-1', target: 'main' }, reused: false }), diff: async () => null, status: async () => ({ pullRequest: { id: 7, status: prState } }) };
    const out = await run1('lyam-request-publish', mk({ publish: publish as never, runBranch: 'wf-run-1', config: { await: 'no' } }).c as never);
    assert.equal((out.pullRequest as Record<string, unknown>).id, 7);
    const requested: Record<string, unknown>[] = [];
    let chk: Record<string, unknown> = { state: 'open', task: { id: 'task-5', kind: 'publish-approval', status: 'open', detail: { pr: { id: 7 } } } };
    const settled: { id: string; note: string }[] = [];
    const tasks = { check: async () => chk, request: async (a: Record<string, unknown>) => { requested.push(a); return { id: 'task-6' }; }, settleSystem: async (_t: string, id: string, _a: string, note: string) => { settled.push({ id, note }); return true; } };
    await assert.rejects(externalBlock('lyam-request-publish')!.run(mk({ publish: publish as never, tasks: tasks as never, runBranch: 'wf-run-1', config: { await: 'yes' } }).c), /waiting/);
    assert.equal(requested[0].kind, 'publish-approval');
    assert.equal(requested[0].assignee, 'admin');
    assert.ok(requested[0].dueInSeconds, 'the approval wait is bounded (overdue rescan re-reads the real PR state)');
    // Refused while open: failure.
    chk = { state: 'decided', task: { id: 'task-5', kind: 'publish-approval', status: 'decided', decision: 'refused', justification: 'bad data', detail: { pr: { id: 7 } } } };
    await assert.rejects(externalBlock('lyam-request-publish')!.run(mk({ publish: publish as never, tasks: tasks as never, runBranch: 'wf-run-1', config: { await: 'yes' }, resumeWait: { taskId: 'task-5', kind: 'lyam-request-publish' } }).c), /refused: bad data/);
    // Approved but PR still open: a merge-watch starts, the run keeps waiting (no success on approval alone).
    chk = { state: 'decided', task: { id: 'task-5', kind: 'publish-approval', status: 'decided', decision: 'approved', decided_by: 'root', detail: { pr: { id: 7 } } } };
    await assert.rejects(externalBlock('lyam-request-publish')!.run(mk({ publish: publish as never, tasks: tasks as never, runBranch: 'wf-run-1', config: { await: 'yes' }, resumeWait: { taskId: 'task-5', kind: 'lyam-request-publish' } }).c), /waiting/);
    assert.equal(requested[1].kind, 'publish-merge-watch');
    assert.equal((requested[1].detail as Record<string, unknown>).rescan, true);
    // Watch + PR closed without merge: failure. Watch + PR merged: success.
    chk = { state: 'open', task: { id: 'task-6', kind: 'publish-merge-watch', status: 'open', detail: { pr: { id: 7 } } } };
    prState = 'closed';
    await assert.rejects(externalBlock('lyam-request-publish')!.run(mk({ publish: publish as never, tasks: tasks as never, runBranch: 'wf-run-1', config: { await: 'yes' }, resumeWait: { taskId: 'task-6', kind: 'lyam-request-publish' } }).c), /closed without merge/);
    assert.deepEqual(settled.map((x) => x.id), ['task-6'], 'the open watch was settled when the PR closed, audit note recorded');
    prState = 'merged';
    const done = await run1('lyam-request-publish', mk({ publish: publish as never, tasks: tasks as never, runBranch: 'wf-run-1', config: { await: 'yes' }, resumeWait: { taskId: 'task-6', kind: 'lyam-request-publish' } }).c as never);
    assert.equal(done.merged, true);
    assert.deepEqual(settled.map((x) => x.id), ['task-6', 'task-6'], 'the open watch was settled when the merge landed');
    // Point 2: the PR is merged BEFORE the approval is decided - the orphan approval is settled, the run concludes from the real state.
    prState = 'merged';
    chk = { state: 'open', task: { id: 'task-5', kind: 'publish-approval', status: 'open', detail: { pr: { id: 7 } } } };
    const early = await run1('lyam-request-publish', mk({ publish: publish as never, tasks: tasks as never, runBranch: 'wf-run-1', config: { await: 'yes' }, resumeWait: { taskId: 'task-5', kind: 'lyam-request-publish' } }).c as never);
    assert.equal(early.merged, true, 'a direct merge concludes the publication even without the approval');
    assert.deepEqual(settled.map((x) => x.id), ['task-6', 'task-6', 'task-5'], 'the orphan approval task was settled, not left open forever');
    prState = 'closed';
    chk = { state: 'open', task: { id: 'task-5', kind: 'publish-approval', status: 'open', detail: { pr: { id: 7 } } } };
    await assert.rejects(externalBlock('lyam-request-publish')!.run(mk({ publish: publish as never, tasks: tasks as never, runBranch: 'wf-run-1', config: { await: 'yes' }, resumeWait: { taskId: 'task-5', kind: 'lyam-request-publish' } }).c), /closed without merge/);
    assert.deepEqual(settled.map((x) => x.id), ['task-6', 'task-6', 'task-5', 'task-5'], 'closed before approval: orphan settled too');
    prState = 'open';
    // A human "merged" marking contradicted by the real PR state fails honestly.
    prState = 'open';
    chk = { state: 'decided', task: { id: 'task-6', kind: 'publish-merge-watch', status: 'decided', decision: 'merged', detail: { pr: { id: 7 } } } };
    await assert.rejects(externalBlock('lyam-request-publish')!.run(mk({ publish: publish as never, tasks: tasks as never, runBranch: 'wf-run-1', config: { await: 'yes' }, resumeWait: { taskId: 'task-6', kind: 'lyam-request-publish' } }).c), /still open/);
  });
  it('lyam-request-publish: a run that wrote NOTHING opens no pull request (explicit skip, no useless review)', async () => {
    let requested = 0;
    const publish = { request: async () => { requested++; return { pullRequest: { id: 7 }, reused: false }; }, status: async () => ({ pullRequest: { id: 7, status: 'open' } }) };
    const out = (await run1('lyam-request-publish', mk({ publish: publish as never, config: { title: 'x' } }).c as never)) as Record<string, unknown>;
    assert.equal(out.skipped, true);
    assert.equal(out.pullRequest, null);
    assert.equal(requested, 0, 'no PR is opened without a run branch');
  });

});
