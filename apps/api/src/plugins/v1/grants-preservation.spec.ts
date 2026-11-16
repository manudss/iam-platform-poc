import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsAdminController } from './plugins-admin.controller.js';
import { PluginRegistry } from './registry.js';

test('enable only changes explicitly submitted runtime grants, never install history', async () => {
  let state = { install: true, uiComponents: true, hooks: ['risk.score'] };
  const reg = { enable: async (_t: string, _id: string, grants: object) => { state = { ...state, ...grants }; } };
  const controller = new PluginsAdminController(reg as unknown as PluginRegistry, undefined as never);
  await controller.enable('demo', 'plugin', {});
  assert.deepEqual(state, { install: true, uiComponents: true, hooks: ['risk.score'] });
  await controller.enable('demo', 'plugin', { grants: { install: false } });
  assert.equal(state.install, true);
  await controller.enable('demo', 'plugin', { grants: { uiComponents: false, hooks: [] } });
  assert.deepEqual(state, { install: true, uiComponents: false, hooks: [] });
  state.install = false;
  await controller.enable('demo', 'plugin', { grants: { install: true } });
  assert.equal(state.install, false);
  await controller.enable('demo', 'plugin', { grants: 'invalid' });
  assert.equal(state.install, false);
});
