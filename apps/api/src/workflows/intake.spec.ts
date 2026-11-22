import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Load the module graph in production order (business services cross-reference plugin wiring).
import { WorkflowsModule } from './workflows.module.js';
import { WorkflowIntake } from './intake.js';
void WorkflowsModule;

describe('workflow intake adapter (business services doubled)', () => {
  const setup = () => {
    let request = { id: 'applicant', confirmed: true, email: 'private@example.invalid', values: { address: 'private' } };
    const calls: string[] = [];
    const signup = { list: (tenant: string) => ({ requests: tenant === 'acme' ? [request] : [] }), approve: async (_t: string, id: string, actor: string) => { calls.push(`approve:${id}:${actor}`); }, reject: (id: string) => { calls.push(`reject:${id}`); } };
    const profile = { reviews: async () => ({ reviews: [{ id: 'employee', changes: [{ key: 'x', to: 1 }] }] }), resolveReviewedSnapshot: async (_t: string, id: string, approved: boolean, actor: string) => { calls.push(`profile:${id}:${approved}:${actor}`); } };
    return { service: new WorkflowIntake(signup as never, profile as never), calls, mutate: () => { request = { ...request, values: { address: 'changed' } }; } };
  };
  it('admin starter only, scoped tenant, no PII in output, exact snapshot required', async () => {
    const workspace = process.env.IAM_WORKSPACE_MODE; process.env.IAM_WORKSPACE_MODE = '1';
    const old = process.env.IAM_API_ADMIN_SUBJECTS; process.env.IAM_API_ADMIN_SUBJECTS = 'admin';
    try {
      const { service, calls, mutate } = setup();
      await assert.rejects(service.read('acme', 'signup', 'applicant', 'someone'), /administrator/);
      await assert.rejects(service.read('other', 'signup', 'applicant', 'admin'), /tenant/);
      const r = await service.read('acme', 'signup', 'applicant', 'admin');
      assert.ok(!JSON.stringify(r).includes('private'));
      mutate(); await assert.rejects(service.resolve('acme', 'signup', 'applicant', r.snapshot, 'approve', 'admin'), /changed/);
      assert.equal(calls.length, 0);
      const fresh = await service.read('acme', 'signup', 'applicant', 'admin');
      assert.equal((await service.resolve('acme', 'signup', 'applicant', fresh.snapshot, 'approve', 'admin')).publicationRequired, true);
      assert.deepEqual(calls, ['approve:applicant:admin']);
    } finally { if (workspace === undefined) delete process.env.IAM_WORKSPACE_MODE; else process.env.IAM_WORKSPACE_MODE = workspace; if (old === undefined) delete process.env.IAM_API_ADMIN_SUBJECTS; else process.env.IAM_API_ADMIN_SUBJECTS = old; }
  });
  it('profile resolution reuses the business rule, starter cannot resolve own request', async () => {
    const old = process.env.IAM_API_ADMIN_SUBJECTS; process.env.IAM_API_ADMIN_SUBJECTS = 'admin,employee';
    try {
      const { service, calls } = setup(); const r = await service.read('acme', 'profile', 'employee', 'admin');
      await assert.rejects(service.resolve('acme', 'profile', 'employee', r.snapshot, 'approve', 'employee'), /own/);
      assert.equal((await service.resolve('acme', 'profile', 'employee', r.snapshot, 'reject', 'admin')).immediate, true);
      assert.deepEqual(calls, ['profile:employee:false:admin']);
    } finally { if (old === undefined) delete process.env.IAM_API_ADMIN_SUBJECTS; else process.env.IAM_API_ADMIN_SUBJECTS = old; }
  });
});

// The actual ProfileService lock is exercised against controlled storage callbacks. Single process only.
import { ProfileService } from '../profile/profile.service.js';
import { createHash } from 'node:crypto';
describe('profile reviewed-snapshot serialization', () => {
  it('self edits wait while the reviewed snapshot is being resolved; a stale snapshot is refused', async () => {
    const service = new ProfileService({} as never, {} as never);
    let request = { id: 'employee', changes: [{ key: 'field', to: 'reviewed' }] };
    let release!: () => void; let inside!: () => void;
    const entered = new Promise<void>(r => { inside = r; });
    const gate = new Promise<void>(r => { release = r; });
    const order: string[] = [];
    (service as any).reviews = async () => ({ reviews: [request] });
    (service as any).resolveReviewUnlocked = async () => { order.push('resolve'); inside(); await gate; order.push('resolved'); };
    (service as any).patchSelfUnlocked = async () => { order.push('edit'); request = { ...request, changes: [{ key: 'field', to: 'new' }] }; };
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const resolving = service.resolveReviewedSnapshot('acme', 'employee', true, 'admin', digest);
    await entered;
    const edit = service.patchSelf('acme', 'employee', {});
    await new Promise(r => setImmediate(r));
    assert.deepEqual(order, ['resolve']);
    release(); await resolving; await edit;
    assert.deepEqual(order, ['resolve', 'resolved', 'edit']);
    await assert.rejects(service.resolveReviewedSnapshot('acme', 'employee', true, 'admin', digest), /changed since review/);
  });
});
