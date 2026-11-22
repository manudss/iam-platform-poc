// Relaunch claims (retry / rerunFrom): the atomic transition is the exclusive right to relaunch, and a
// failure AFTER the claim (store dying mid-reset, engine slot unresolvable for the stale-flag clear) must
// leave the run back in its pre-claim state - retryable - with no pass started. The clear of the stale
// cancel flag is fail-safe: it rejects through the facade instead of letting a kick start on the old flag.
import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowEngine } from './engine.js';
import { validateGraph } from './model.js';

const graph = () => validateGraph({ nodes: [{ id: 'a', type: 'notify', name: 'a', config: { recipient: 'x', message: 'y' } }], edges: [] }).graph;
const mkRow = () => ({ id: 'run-test', tenant: 'acme-demo', definition_id: 'wf-def', name: 't', graph: graph(), branch: null, base_branch: null, status: 'canceled', error: 'boom', started_by: 'tester', started_at: 'now', finished_at: 'then', test: false });
const mkStep = () => ({ run_id: 'run-test', node_id: 'a', status: 'pending', simulated: true, attempts: 1, error: null, log: [], input: { recipient: 'x', message: 'y', wait: { taskId: 'task-old', kind: 'approval' } }, output: null, started_at: null, finished_at: null });

const harness = (opts: { patchFails?: boolean; clearFails?: boolean }) => {
  const row = mkRow();
  const step = mkStep();
  let kicked = false, cleared = 0;
  const transitions: { patch: Record<string, unknown>; from: string[] }[] = [];
  const store = {
    getRun: async () => row,
    steps: async () => [step],
    transitionRun: async (_id: string, patch: Record<string, unknown>, from: string[]) => { transitions.push({ patch, from }); if (!from.includes(row.status as string)) return false; Object.assign(row, patch); return true; },
    patchStep: async () => { if (opts.patchFails) throw new Error('store gone mid-reset'); Object.assign(step, { status: 'pending', input: null }); },
  };
  const engine = {
    clearStaleCancel: async () => { if (opts.clearFails) throw new Error('engine slot unresolvable'); cleared++; },
    kick: () => { kicked = true; },
  };
  const svc = new WorkflowsService(store as never, engine as never, null as never, null as never);
  return { svc, row, step, transitions, get kicked() { return kicked; }, get cleared() { return cleared; } };
};

describe('relaunch claim: safe exit after a won claim', () => {
  it('a store failure mid-reset restores the pre-claim state (retryable) and never kicks', async () => {
    const h = harness({ patchFails: true });
    await assert.rejects(() => h.svc.retry('acme-demo', 'run-test'), /store gone mid-reset/);
    assert.equal(h.row.status, 'canceled', 'the run is back in its pre-claim status: a later retry is allowed');
    assert.equal(h.row.error, 'boom', 'the original failure context is preserved');
    assert.equal(h.row.finished_at, 'then');
    assert.equal(h.kicked, false, 'no pass was started on a half-prepared run');
    assert.deepEqual(h.transitions.map((t) => t.from), [['failed', 'canceled'], ['queued']], 'claim from terminal states, guarded restore from queued only');
  });

  it('an unresolvable engine for the stale-flag clear restores the run and never kicks on the old flag', async () => {
    const h = harness({ clearFails: true });
    await assert.rejects(() => h.svc.retry('acme-demo', 'run-test'), /engine slot unresolvable/);
    assert.equal(h.row.status, 'canceled', 'restored to the pre-claim status');
    assert.equal(h.kicked, false, 'the kick was skipped: no pass on the stale cancel flag');
  });

  it('a clean claim clears the stale flag exactly once, then kicks', async () => {
    const h = harness({});
    const v = await h.svc.retry('acme-demo', 'run-test');
    assert.equal(v.run.status, 'queued');
    assert.equal(h.cleared, 1);
    assert.equal(h.kicked, true);
    assert.equal(h.step.input, null, 'the parked step lost its reference to the canceled task (it will open a fresh one)');
  });
});

describe('facade: clearStaleCancel is the fail-safe delegation', () => {
  it('rejects when the run is unknown instead of letting a kick proceed', async () => {
    const engine = new WorkflowEngine({ getRunById: async () => null } as never, { defaultBranch: 'main' } as never, { resolve: () => { throw new Error('no provider'); } } as never);
    await assert.rejects(() => engine.clearStaleCancel('run-gone', Date.now()), /not found/);
  });
});
