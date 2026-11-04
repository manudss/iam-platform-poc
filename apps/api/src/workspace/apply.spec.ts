import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceController } from './workspace.controller.js';
import { branchContext } from './context.js';

const NOTHING = 'nothing to merge: the target already contains the source';
const HEAD = '0123456789abcdef';
function setup(reasons = [NOTHING], latest?: { state: string; commit: string; requestId?: string }) {
  const activated: string[] = [];
  const v = {
    branches: async () => ({ branches: [{ name: 'main', commit: HEAD }, { name: 'work', commit: HEAD }] }),
    diffSummary: async () => ({ tables: [] }),
    mergeInto: async () => ({ mergeable: !reasons.length, commit: reasons.length ? null : HEAD, reasons, violations: [] }),
  };
  const activation = { applyEnabled: true, current: async () => latest,
    activate: async (_tenant: string, commit: string) => { activated.push(commit); return { state: 'applied', commit }; } };
  const registries = { drop: () => undefined, get: async () => ({}) };
  const controller = new WorkspaceController(v as never, registries as never, activation as never, {} as never, {} as never);
  const apply = (body: { confirm?: boolean; expectedHead?: string } = { confirm: true }) => branchContext.run({ branch: 'work' }, () => controller.apply(body, { user: { sub: 'demo-alice' } }, 'acme-demo'));
  return { activated, apply };
}
describe('human Apply first activation without data changes', () => {
  it('activates current main after the checked no-op merge', async () => {
    process.env.IAM_WORKSPACE_MODE = '1';
    const t = setup(); const result = await t.apply();
    assert.equal(result.applied, true); assert.equal(result.commit, HEAD);
    assert.deepEqual(t.activated, [HEAD]);
  });
  it('retains explicit confirmation and expected-head checks', async () => {
    const t = setup();
    await assert.rejects(t.apply({}), /Explicit Apply confirmation/);
    await assert.rejects(t.apply({ confirm: true, expectedHead: 'stale' }), /Working branch changed/);
    assert.deepEqual(t.activated, []);
  });
  for (const reason of ['1 Separation-of-Duties violation(s)', '1 constraint violation(s)', '1 data conflict(s)']) {
    it(`never bootstraps around ${reason}`, async () => {
      const t = setup([reason, NOTHING]);
      await assert.rejects(t.apply(), /Apply refused/); assert.deepEqual(t.activated, []);
    });
  }
  it('refuses an already applied no-op rather than creating another activation', async () => {
    const t = setup([NOTHING], { state: 'applied', commit: HEAD });
    await assert.rejects(t.apply(), /nothing to merge/); assert.deepEqual(t.activated, []);
  });
  it('keeps the normal merge-and-activate path', async () => {
    const t = setup([]); assert.equal((await t.apply()).applied, true); assert.deepEqual(t.activated, [HEAD]);
  });
});
