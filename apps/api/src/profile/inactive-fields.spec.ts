import 'reflect-metadata';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { MemoryMigrationStore, MemorySettingsStore } from '../plugins/v1/memory-stores.js';
import { hrAttributes } from '../plugins/v1/builtin/index.js';
it('lists installed inactive fields only for information, never in the active catalogue', async () => {
  const r = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
  r.register(hrAttributes);
  assert.deepEqual(r.inactiveProfileFields('t'), [], 'not installed');
  await r.install('t', hrAttributes.manifest.id, { install: true });
  assert.equal(r.inactiveProfileFields('t')[0].plugin, hrAttributes.manifest.id);
  assert.deepEqual(r.profileFields('t'), [], 'inactive fields do not enter the effective form');
  await r.enable('t', hrAttributes.manifest.id);
  assert.deepEqual(r.inactiveProfileFields('t'), []);
  assert.equal(r.profileFields('t')[0].plugin, hrAttributes.manifest.id);
});
