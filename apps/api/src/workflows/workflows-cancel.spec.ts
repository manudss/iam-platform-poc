import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowsModule } from './workflows.module.js';
import { WorkflowsService } from './workflows.service.js';
void WorkflowsModule;

describe('cancel endpoint terminal-state race', () => {
  function fixture(winner: string, initial = 'waiting') {
    const row = { id: 'run-race', status: initial, finished_at: null as string | null };
    let writes = 0, taskCancels = 0;
    const service = {
      runView: async () => ({ run: { ...row } }),
      engine: { cancelFlag: () => { row.status = winner; row.finished_at = 'executor-finished'; } },
      tasksSvc: () => ({ cancelForRun: async () => { taskCancels++; } }),
      store: { transitionRun: async () => { writes++; return false; }, getRun: async () => ({ ...row }) },
    };
    return { service, row, calls: () => ({ writes, taskCancels }) };
  }
  it('succeeds when its awakened executor already committed canceled before the endpoint CAS', async () => {
    const h = fixture('canceled');
    const result = await WorkflowsService.prototype.cancel.call(h.service as never, 'acme', 'run-race');
    assert.equal(result.run.status, 'canceled');
    assert.equal(h.row.finished_at, 'executor-finished');
    assert.deepEqual(h.calls(), { writes: 1, taskCancels: 1 });
  });
  for (const terminal of ['completed', 'failed']) it(`refuses a competing ${terminal} result without overwriting it`, async () => {
    const h = fixture(terminal);
    await assert.rejects(WorkflowsService.prototype.cancel.call(h.service as never, 'acme', 'run-race'), /cancel did not land/);
    assert.equal(h.row.status, terminal);
    assert.equal(h.row.finished_at, 'executor-finished');
  });
  it('still refuses an already terminal run at entry', async () => {
    const h = fixture('canceled', 'canceled');
    await assert.rejects(WorkflowsService.prototype.cancel.call(h.service as never, 'acme', 'run-race'), /already canceled/);
    assert.deepEqual(h.calls(), { writes: 0, taskCancels: 0 });
  });
});
