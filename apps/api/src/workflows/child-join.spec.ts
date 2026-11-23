import 'reflect-metadata';
import '../authn/flow.service.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from './engine.js';
import { externalBlock } from './model.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
const { WorkflowSuspend } = loadPluginModule('workflows-iga', 'model.mjs') as any;
const effects = (getRun: any) => (WorkflowEngine.prototype as any).runEffects.call({ store: { getRun } });
describe('durable direct-child join', () => {
  it('binds tenant/direct parent, refuses self, unknown, foreign and non-child without a completion claim', async () => {
    for (const child of [null, { id: 'parent', started_by: 'workflow:parent', status: 'completed' }, { id: 'other', started_by: 'workflow:someone', status: 'completed' }]) {
      const reads: any[] = [];
      const fx = effects(async (...args: any[]) => { reads.push(args); return child; });
      await assert.rejects(fx.joinChild('tenant', 'parent', child?.id ?? 'unknown', 1, null), /direct child/);
      assert.equal(reads[0][0], 'tenant');
    }
  });
  it('persists the original deadline; completed succeeds, failed/canceled/expired refuse, malformed prior refuses', async () => {
    let status = 'waiting'; const fx = effects(async () => ({ id: 'child', started_by: 'workflow:parent', status }));
    const first = await fx.joinChild('tenant', 'parent', 'child', 1, null);
    assert.equal(first.wait.kind, 'child-run'); assert.equal(first.wait.childRunId, 'child');
    assert.equal((await fx.joinChild('tenant', 'parent', 'child', 720, first.wait)).wait.deadlineAt, first.wait.deadlineAt);
    status = 'completed'; assert.deepEqual(await fx.joinChild('tenant', 'parent', 'child', 1, first.wait), { id: 'child', status: 'completed', finished: true });
    for (status of ['failed', 'canceled']) await assert.rejects(fx.joinChild('tenant', 'parent', 'child', 1, first.wait), new RegExp(status));
    for (const prior of [{ ...first.wait, childRunId: 'other' }, { ...first.wait, deadlineAt: 'future' }, { ...first.wait, kind: 'approval' }]) await assert.rejects(fx.joinChild('tenant', 'parent', 'child', 1, prior), /invalid/);
    status = 'completed'; await assert.rejects(fx.joinChild('tenant', 'parent', 'child', 1, { ...first.wait, deadlineAt: Date.now() - 1 }), /deadline expired/);
  });
  it('block simulation reads nothing; pending suspends with recorded state and never emits child outputs', async () => {
    const b = externalBlock('lyam-join-child-run')!; let reads = 0;
    assert.throws(() => b.validate({ runId: 'child', timeoutHours: 721 }), /720/);
    const config = b.validate({ runId: 'child', timeoutHours: 1 }); assert.deepEqual(b.validate(config), config);
    const ctx: any = { tenant: 'tenant', runId: 'parent', config, log() {}, runs: { joinChild: async () => { reads++; return { wait: { kind: 'child-run', childRunId: 'child', deadlineAt: 123 } }; } }, test: true };
    assert.equal((await b.run(ctx))!.finished, false); assert.equal(reads, 0);
    ctx.test = false;
    await assert.rejects(b.run(ctx), (e: any) => e instanceof WorkflowSuspend && e.wait.deadlineAt === 123);
    assert.equal(reads, 1);
  });
  it('scanner only kicks actual pending child waits that became terminal/missing/expired, never successful by itself', async () => {
    const kicked: string[] = []; let child: any = { id: 'child', started_by: 'workflow:parent', status: 'waiting' }; let deadlineAt = Date.now() + 10000;
    const parent = { id: 'parent', tenant: 'tenant', status: 'waiting', graph: { nodes: [{ id: 'join', type: 'lyam-join-child-run' }] } };
    const fixture = { store: { runningRuns: async () => [parent], steps: async () => [{ node_id: 'join', status: 'pending', input: { wait: { kind: 'child-run', childRunId: 'child', deadlineAt } } }], getRun: async () => child }, kick: (id: string) => kicked.push(id) };
    const scan = () => (WorkflowEngine.prototype as any).scanChildWaits.call(fixture);
    await scan(); assert.deepEqual(kicked, []);
    for (child of [{ status: 'completed' }, { status: 'failed' }, { status: 'canceled' }, null].map(c => c ? { id: 'child', started_by: 'workflow:parent', ...c } : null)) await scan();
    assert.equal(kicked.length, 4); child = { id: 'child', started_by: 'workflow:parent', status: 'waiting' }; deadlineAt = 0; await scan(); assert.equal(kicked.length, 5);
    parent.status = 'canceled'; await scan(); assert.equal(kicked.length, 5);
  });
});
