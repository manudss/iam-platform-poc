import 'reflect-metadata';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowHooksController } from './hooks.controller.js';
import { WorkflowSheetPollerService } from './sheet-poller.js';
import { currentBranch } from '../workspace/context.js';

it('public webhook and background sheet watcher select main registry and establish main context', async () => {
  const old = process.env.IAM_WORKSPACE_MODE;
  process.env.IAM_WORKSPACE_MODE = '1';
  const selected: string[] = [];
  let starts = 0;
  const active = { isActive: () => true, impl: () => ({ manifest: { settings: [] } }), settingsFor: async () => ({}) };
  const disabled = { isActive: () => false };
  const branches = { get: async (ref: string) => { selected.push(ref); return active; } };
  const store = { liveRef: 'main', getDefinition: async () => ({ id: 'wf', trigger: { event: 'http.webhook-received', config: { token: 'test-only-token' } } }), listAllDefinitions: async () => [{ id: 'sheet', tenant: 'acme', trigger: { event: 'google-sheets.row-ready', config: { source: 'demo-sheet' } } }] };
  const wf = { start: async () => { assert.equal(currentBranch(), 'main'); starts++; return { run: { id: 'test-run', status: 'completed' } }; } };
  try {
    const hook = new WorkflowHooksController(store as never, wf as never, disabled as never, branches as never);
    assert.equal((await hook.fire('acme', 'wf', 'test-only-token', {})).run, 'test-run');
    const poller = new WorkflowSheetPollerService(store as never, wf as never, disabled as never, branches as never);
    await poller.tick();
    assert.ok(starts >= 2, 'watcher used enabled main registry rather than disabled legacy registry');
    assert.deepEqual(selected, ['main', 'main']);
    poller.onModuleDestroy();
  } finally {
    if (old === undefined) delete process.env.IAM_WORKSPACE_MODE; else process.env.IAM_WORKSPACE_MODE = old;
  }
});
