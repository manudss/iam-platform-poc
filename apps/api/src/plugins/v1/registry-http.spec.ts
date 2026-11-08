import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins } from './loader.js';
import { PluginRegistry } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from './memory-stores.js';
import { validateSettings } from './settings.js';

// Step 2+3 unit coverage (no bus needed): menu entries and http route dispatch come from the active plugins' manifests.
describe('plugin menu + http routes', () => {
  let reg: PluginRegistry;
  before(async () => {
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {}, new MemoryStateStore());
    for (const p of loadPlugins()) reg.register(p);
    await reg.load();
    await reg.install('t1', 'organizations', {});
    await reg.enable('t1', 'organizations', { uiComponents: true }); // menu entries + routes require the screens grant (step 1b)
    await reg.install('t1', 'org-manager', { install: true });
    await reg.configure('t1', 'org-manager', { maxDepth: 4 });
    await reg.enable('t1', 'org-manager', {});
  });
  it('menu entries appear only while the plugin is active, per tenant', () => {
    assert.deepEqual(reg.menu('t1').filter((e) => e.plugin === 'organizations').map((e) => ({ id: e.id, path: e.path, group: e.group })), [{ id: 'organizations', path: '/screens/organizations/orgs', group: 'Access (IAM)' }]);
    assert.equal(reg.menu('t2').filter((e) => e.plugin === 'organizations').length, 0);
  });
  it('http route dispatch: method + path + params, active plugin only', async () => {
    const hit = reg.httpRoute('t1', 'org-manager', 'GET', 'ping');
    assert.ok(hit);
    const settings = validateSettings(hit.impl.manifest.settings, (await reg.settingsFor('t1', 'org-manager')) ?? {}).values;
    assert.deepEqual(await hit.handler({ method: 'GET', params: hit.params, query: {}, body: undefined, user: undefined }, { tenant: 't1', settings }), { pong: true, tenant: 't1', maxDepth: 4 });
    assert.equal(reg.httpRoute('t1', 'org-manager', 'POST', 'ping'), undefined); // method not declared
    assert.equal(reg.httpRoute('t2', 'org-manager', 'GET', 'ping'), undefined); // not enabled on t2
    assert.equal(reg.httpRoute('t1', 'unknown-plugin', 'GET', 'ping'), undefined);
  });
  it('a declared route without a handler is a fault, not a 404: registration is refused', () => {
    assert.throws(() => reg.register({ manifest: { apiVersion: 'plugin/v3', id: 'broken-http', version: '1.0.0', name: 'Broken', publisher: 'iam-platform', kinds: ['ui'], hooks: [], settings: [], httpRoutes: [{ method: 'GET', path: '/x', auth: 'public' }] }, handlers: {} }), /declared but no handler/);
  });
});
