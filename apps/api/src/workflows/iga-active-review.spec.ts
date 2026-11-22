import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowTasksService } from './tasks.js';
import type { TaskRow } from './store.js';

const env = { ...process.env };
beforeEach(() => { process.env.IAM_API_ADMIN_SUBJECTS = 'admin'; process.env.IAM_API_IGA_SUBJECTS = 'first,second'; });
afterEach(() => { process.env = { ...env }; });
function setup(states: Record<string, boolean | null | 'missing' | 'outage'>) {
  const tasks: TaskRow[] = [], reads: string[] = [];
  const store = { listTasks: async () => tasks, putTask: async (t: TaskRow) => { tasks.push(t); return t; } };
  const service = new WorkflowTasksService(store as never, undefined, undefined, { readUser: async (tenant: string, ref: string, id: string) => {
    assert.equal(tenant, 'acme'); assert.equal(ref, 'main'); reads.push(id);
    if (states[id] === 'missing') throw new BadRequestException(`unknown identity "${id}"`);
    if (states[id] === 'outage') throw new Error('connection failed');
    return { id, loginEnabled: states[id] ?? null };
  } });
  return { service, tasks, reads };
}
describe('IGA eligible live pool selection (service with controlled reads)', () => {
  it('skips disabled, unknown and missing-login members and selects an active member in configured order', async () => {
    for (const first of [false, null, 'missing'] as const) {
      const { service, reads } = setup({ first, second: true });
      assert.equal(await service.activeReviewAssignee('acme', 'iga'), 'second');
      assert.deepEqual(reads, ['first', 'second']);
    }
  });
  it('excludes the beneficiary even when the beneficiary is the only active pool member', async () => {
    const { service } = setup({ first: true, second: true });
    assert.equal(await service.activeReviewAssignee('acme', 'iga', ['first']), 'second');
    await assert.rejects(service.activeReviewAssignee('acme', 'iga', ['first', 'second']), /no eligible/);
  });
  it('does not select a later member after an unavailable read', async () => {
    const { service, reads } = setup({ first: 'outage', second: true });
    await assert.rejects(service.activeReviewAssignee('acme', 'iga'), /unavailable.*read failed/);
    assert.deepEqual(reads, ['first']);
  });
  it('fails closed for an empty pool and for all members disabled or unknown', async () => {
    const { service } = setup({ first: false, second: 'missing' });
    await assert.rejects(service.activeReviewAssignee('acme', 'iga'), /no eligible/);
    process.env.IAM_API_IGA_SUBJECTS = ''; process.env.IAM_API_ADMIN_SUBJECTS = '';
    await assert.rejects(service.activeReviewAssignee('acme', 'iga'), /pool is empty/);
  });
  it('a concrete target is validated, never silently replaced with a pool member', async () => {
    const { service } = setup({ first: false, second: true });
    await assert.rejects(service.activeReviewAssignee('acme', 'first'), /no eligible/);
  });
  it('request records the pool but assigns an active non-beneficiary; replay reuses the same task and deadline', async () => {
    const { service, tasks } = setup({ first: true, second: true });
    const input = { tenant: 'acme', kind: 'iga-review', title: 'Review', detail: { identity: 'first' }, assignee: 'iga', preventSelfApproval: true, runId: 'run', nodeId: 'item', dueInSeconds: 3600 };
    const task = await service.request(input);
    assert.equal(task.assignee, 'second'); assert.equal(task.detail.pool, 'iga');
    const replay = await service.request(input);
    assert.equal(replay.id, task.id); assert.equal(replay.due_at, task.due_at); assert.equal(tasks.length, 1);
  });
  it('no task or event is written when selection fails', async () => {
    const { service, tasks } = setup({ first: false, second: false });
    await assert.rejects(service.request({ tenant: 'acme', kind: 'iga-review', title: 'Review', assignee: 'iga', runId: 'run', nodeId: 'item' }), /no eligible/);
    assert.equal(tasks.length, 0);
  });
});
