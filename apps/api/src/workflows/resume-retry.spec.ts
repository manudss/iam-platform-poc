// Boot resume with an unresolvable engine slot (provider plugin still down): the engine retries with a bounded
// backoff, then leaves the run with an explicit RESUME_FAILED error instead of a silent stuck 'running'.
// The status is never touched and no step is replayed: a retry only ever re-enters through kick, which
// re-derives execution from the persisted steps. A later successful resume clears only that marker.
import 'reflect-metadata';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from './engine.js';
import { PluginError } from '../plugins/v1/registry.js';

const RETRY_ENV = 'WF_RESUME_RETRY_DELAYS_MS';
const savedEnv = process.env[RETRY_ENV];
afterEach(() => { if (savedEnv === undefined) delete process.env[RETRY_ENV]; else process.env[RETRY_ENV] = savedEnv; });

interface Patch { id: string; marker: string | null }
const harness = (runs: { id: string; tenant: string; branch: string | null }[]) => {
  const marks: Patch[] = [], clears: string[] = [];
  const store = {
    runningRuns: async () => runs,
    markResumeFailed: async (id: string, message: string) => { marks.push({ id, marker: message }); },
    clearResumeFailed: async (id: string) => { clears.push(id); },
    updateRun: async () => { throw new Error('updateRun must not be used for resume markers'); },
  };
  return { store, marks, clears };
};
const failingRegistry = (counter: { n: number }) => ({ resolve: () => { counter.n++; throw new PluginError('no-provider', 'workflows.engine: no provider plugin enabled (the slot only has its refusing base)'); } });

describe('boot resume with an unavailable engine slot', () => {
  it('retries with a bounded backoff then marks the run RESUME_FAILED, status untouched', async () => {
    process.env[RETRY_ENV] = '5,5';
    const { store, marks } = harness([{ id: 'run-stuck', tenant: 'acme-demo', branch: null }]);
    const counter = { n: 0 };
    const engine = new WorkflowEngine(store as never, { defaultBranch: 'main' } as never, failingRegistry(counter) as never);
    await engine.onModuleInit();
    const until = Date.now() + 5000;
    while (!marks.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(marks.length, 1, 'the stuck run gets exactly one explicit marker');
    assert.equal(marks[0].id, 'run-stuck');
    assert.match(String(marks[0].marker), /RESUME_FAILED: engine unavailable after 3 attempts/, 'the marker is explicit and reconciliable');
    assert.equal(counter.n, 3, 'one initial attempt plus the two bounded retries, then it stops');
    engine.onModuleDestroy();
  });

  it('a retry that resolves the engine kicks the run and clears only the RESUME_FAILED marker', async () => {
    process.env[RETRY_ENV] = '5,5';
    const { store, marks, clears } = harness([{ id: 'run-late', tenant: 'acme-demo', branch: null }]);
    const engine = new WorkflowEngine(store as never, { defaultBranch: 'main' } as never, failingRegistry({ n: 0 }) as never);
    // The slot refuses at boot, then the provider finishes loading before the first retry.
    let calls = 0; const kicked: string[] = [];
    (engine as unknown as { engineFor: (r: { id: string }) => Promise<{ kick: (id: string) => void }> }).engineFor = async (r) => {
      calls++;
      if (calls === 1) throw new PluginError('no-provider', 'not yet');
      return { kick: (id: string) => { kicked.push(id); } };
    };
    await engine.onModuleInit();
    const until = Date.now() + 5000;
    while (!kicked.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(kicked, ['run-late'], 'the first retry resumed the run');
    assert.deepEqual(clears, ['run-late'], 'a successful resume clears the resume marker of this run only');
    assert.equal(marks.length, 0, 'no failure marker after a successful retry');
    engine.onModuleDestroy();
  });

  it('module destroy stops a pending retry: no timer fires, no late write after close', async () => {
    process.env[RETRY_ENV] = '60000';
    const { store, marks } = harness([{ id: 'run-shutdown', tenant: 'acme-demo', branch: null }]);
    const engine = new WorkflowEngine(store as never, { defaultBranch: 'main' } as never, failingRegistry({ n: 0 }) as never);
    await engine.onModuleInit(); // the first attempt failed, the retry timer is pending
    engine.onModuleDestroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(marks.length, 0, 'no marker is written while shutting down');
  });
});
