// Boot resume with an unresolvable engine slot (provider plugin still down): the engine retries with a bounded
// backoff, then leaves the run with an explicit RESUME_FAILED error instead of a silent stuck 'running'.
// The status is never touched and no step is replayed: a retry only ever re-enters through kick, which
// re-derives execution from the persisted steps.
import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from './engine.js';
import { PluginError } from '../plugins/v1/registry.js';

describe('boot resume with an unavailable engine slot', () => {
  it('retries with a bounded backoff then marks the run RESUME_FAILED, status untouched', async () => {
    process.env.WF_RESUME_RETRY_DELAYS_MS = '5,5';
    let resolveCalls = 0;
    const reg = { resolve: () => { resolveCalls++; throw new PluginError('no-provider', 'workflows.engine: no provider plugin enabled (the slot only has its refusing base)'); } };
    const patches: { id: string; patch: Record<string, unknown> }[] = [];
    const store = {
      runningRuns: async () => [{ id: 'run-stuck', tenant: 'acme-demo', branch: null }],
      updateRun: async (id: string, patch: Record<string, unknown>) => { patches.push({ id, patch }); },
    };
    const engine = new WorkflowEngine(store as never, { defaultBranch: 'main' } as never, reg as never);
    await engine.onModuleInit();
    const until = Date.now() + 5000;
    while (!patches.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(patches.length, 1, 'the stuck run gets exactly one explicit error');
    assert.equal(patches[0].id, 'run-stuck');
    assert.equal(patches[0].patch.status, undefined, 'status is left untouched: no blind replay, no fake failure');
    assert.match(String(patches[0].patch.error), /RESUME_FAILED: engine unavailable after 3 attempts/, 'the error is explicit and reconciliable');
    assert.equal(resolveCalls, 3, 'one initial attempt plus the two bounded retries, then it stops');
  });});
