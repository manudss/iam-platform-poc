import 'reflect-metadata';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { SEEDS, WorkflowDemoSeed } from './demo-seed.js';
import type { DefinitionRow, WorkflowStore } from './store.js';

it('seeds eleven definitions on first boot, keeps existing edits on second boot, and never seeds run results', async () => {
  const saved = new Map<string, DefinitionRow>();
  let writes = 0;
  const store = {
    liveRef: 'main',
    getDefinition: async (_tenant: string, id: string, branch: string) => { assert.equal(branch, 'main'); return saved.get(id); },
    putDefinition: async (def: DefinitionRow, branch: string) => { assert.equal(branch, 'main'); saved.set(def.id, structuredClone(def)); writes++; },
  } as unknown as WorkflowStore;
  const keys = ['IAM_DEMO_DATA_SEED', 'IAM_DEMO_GOOGLE_SPREADSHEET_ID', 'IAM_AUTHN_DEMO_SEED_TENANT'] as const;
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    delete process.env.IAM_DEMO_DATA_SEED;
    delete process.env.IAM_DEMO_GOOGLE_SPREADSHEET_ID;
    process.env.IAM_AUTHN_DEMO_SEED_TENANT = 'acme-demo';
    const seed = new WorkflowDemoSeed(store);
    await seed.onApplicationBootstrap(); assert.equal(writes, 0, 'seed stays opt-in');
    process.env.IAM_DEMO_DATA_SEED = '1';
    await seed.onApplicationBootstrap(); assert.equal(saved.size, 11);
    const hr = saved.get('wf-hr-onboarding')!;
    assert.equal(hr.active, true); assert.equal(hr.graph.nodes.length, 8); assert.equal(hr.graph.edges.length, 7);
    assert.equal(hr.trigger?.config?.source, 'demo-sheet');
    hr.name = 'Presenter edited this'; hr.active = false;
    await seed.onApplicationBootstrap();
    assert.equal(writes, 11, 'second boot does not write any existing definition');
    assert.equal(saved.get(hr.id)!.name, 'Presenter edited this'); assert.equal(saved.get(hr.id)!.active, false);
    assert.equal(saved.has('wf-hr-google-demo'), false, 'no real Google scenario enabled by default');
  } finally {
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  }
});

it('every default external action explicitly stays simulated without a connection or real confirmation', () => {
  let actions = 0;
  for (const seed of SEEDS) for (const node of seed.nodes) {
    if (!/^(google-sheets-|jira-)|^http-request$/.test(node.type)) continue;
    actions++;
    assert.equal(node.config.executionMode, 'simulation', `${seed.id}/${node.id}`);
    assert.equal(node.config.connectionId, undefined);
    assert.equal(node.config.realConfirmed, undefined);
  }
  assert.equal(actions, 4);
});
