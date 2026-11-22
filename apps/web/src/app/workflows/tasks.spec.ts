import {WfTask, decisionChoices, justificationRequired, taskSummary} from './wf-model';

const task = (detail: Record<string, unknown>, over: Partial<WfTask> = {}): WfTask => ({
  id: 't1', tenant: 'acme-demo', kind: 'publish-approval', title: 'Approve', detail,
  assignee: 'demo-alice', delegated_to: null, status: 'open', decision: null, justification: null,
  decided_by: null, run_id: 'r1', node_id: 'publish', prevent_self: false,
  created_at: '2026-11-22 00:00:00.000', due_at: null, reminded_at: null, decided_at: null, ...over,
});

describe('workflow task inbox helpers', () => {
  it('uses the workflow-listed decisions, defaulting to approve/refuse', () => {
    expect(decisionChoices(task({}))).toEqual(['approved', 'refused']);
    expect(decisionChoices(task({decisions: []}))).toEqual(['approved', 'refused']);
    expect(decisionChoices(task({decisions: ['merged', 'closed']}))).toEqual(['merged', 'closed']);
  });
  it('requires a justification for any non-approval and for tasks that ask for one', () => {
    expect(justificationRequired(task({}), 'approved')).toBe(false);
    expect(justificationRequired(task({}), 'refused')).toBe(true);
    // The server asks a justification for every decision except a literal approval.
    expect(justificationRequired(task({decisions: ['merged', 'closed']}), 'merged')).toBe(true);
    expect(justificationRequired(task({requireJustification: true}), 'approved')).toBe(true);
  });
  it('summarizes the useful detail fields only', () => {
    expect(taskSummary(task({identity: 'demo-bob', pr: {id: 7}, campaign: 'c1', other: 'x'}))).toBe('identity demo-bob · PR #7 · campaign c1');
    expect(taskSummary(task({}))).toBe('');
  });
});
