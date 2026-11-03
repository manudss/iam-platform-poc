import { it } from 'node:test';
import assert from 'node:assert/strict';
import { activateDemoMain } from './activate-main.mjs';
function setup(status, state = 'applied') {
  const calls = [];
  return { calls, args: { core: 'http://core', request: async () => ({ ok: status === 200, status }),
    dolt: { head: async () => 'main-commit' },
    activation: { activate: async (...args) => { calls.push(args); return { state, seq: 1 }; } } } };
}
it('fresh demo activates main once without merging a branch', async () => {
  const t = setup(404); assert.equal((await activateDemoMain(t.args)).action, 'activated');
  assert.deepEqual(t.calls, [['acme-demo', 'main-commit', 'demo-bootstrap-main-commit']]);
});
it('preserves an existing active version', async () => {
  const t = setup(200); assert.equal((await activateDemoMain(t.args)).action, 'already-active'); assert.deepEqual(t.calls, []);
});
it('fails closed on an unexpected version response', async () => {
  const t = setup(503); await assert.rejects(activateDemoMain(t.args), /HTTP 503/); assert.deepEqual(t.calls, []);
});
it('does not report a failed activation as ready', async () => {
  const t = setup(404, 'failed'); await assert.rejects(activateDemoMain(t.args), /activation failed/);
});
