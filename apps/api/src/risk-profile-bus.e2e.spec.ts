/**
 * Step 3, commit 8: risk.score is a mandatory CONTROL on the bus and profile.enrich a merged QUERY.
 * - risk.score: only an active plugin answers; deny or no answer at all refuses (sensitive hook, fail closed).
 * - profile.enrich: every active plugin answers with its fields; the reply merges the objects and only the
 *   plugins that answered appear; a disabled plugin disappears from the merge.
 * Real nats-server + real iam-core (the shared bus harness).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry, PluginError, PluginImpl } from './plugins/v1/registry.js';
import { riskGeo, orgManager } from './plugins/v1/builtin/index.js';
import { MemoryMigrationStore, MemorySettingsStore } from './plugins/v1/memory-stores.js';
import { startBusHarness, busBinsPresent, BusHarness } from './testing/bus-harness.js';

const T = 'acme-demo';
const NP = 14227, CORE_PORT = 18099; // own pair: fullstack already uses 14225/18095

/** Second profile plugin: proves the merge picks every responder's fields. */
const profileDept: PluginImpl = {
  manifest: { apiVersion: 'plugin/v1', id: 'profile-dept', version: '0.1.0', name: 'Department enricher', publisher: 'example', kinds: ['profile'], hooks: [{ name: 'profile.enrich', mode: 'blocking' }], settings: [] },
  handlers: { 'profile.enrich': () => ({ department: 'it' }) },
};

describe('risk.score (control) and profile.enrich (query) over the bus', () => {
  let bus: BusHarness; let reg: PluginRegistry;
  before(async () => {
    if (!busBinsPresent) return;
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
    reg.register(riskGeo); reg.register(orgManager); reg.register(profileDept);
    bus = await startBusHarness({ natsPort: NP, corePort: CORE_PORT, token: 'risk-profile-token', registry: reg });
    reg.setBus(bus.host.bridge());
  });
  after(async () => { await bus?.close(); });

  it('risk.score answers through the bus while the plugin is enabled; disabling it refuses (fail closed)', async (t) => {
    if (!bus) return t.skip('no nats-server or core binary');
    await reg.install(T, 'risk-geo', {});
    await reg.enable(T, 'risk-geo', { hooks: ['risk.score'], uiComponents: true });
    await bus.host.sync();
    const r = await reg.control<{ score: number }>(T, 'risk.score', { tenant: T, subject: 'demo-alice', context: {} });
    assert.equal(r.servedBy, 'risk-geo');
    assert.equal(r.result.score, 10);
    await reg.disable(T, 'risk-geo');
    await bus.host.sync();
    await assert.rejects(reg.control(T, 'risk.score', { tenant: T, subject: 'demo-alice', context: {} }),
      (e: PluginError) => e.code === 'plugin-failed', 'no active risk plugin: the sensitive control refuses');
  });

  it('profile.enrich merges the responders; a disabled plugin disappears from the merge', async (t) => {
    if (!bus) return t.skip('no nats-server or core binary');
    await reg.install(T, 'org-manager', { install: true });
    await reg.enable(T, 'org-manager', {});
    await reg.install(T, 'profile-dept', { install: true });
    await reg.enable(T, 'profile-dept', {});
    await bus.host.sync();
    const both = await reg.queryHook<Record<string, unknown>>(T, 'profile.enrich', { tenant: T, subject: 'demo-alice', profile: { displayName: 'Zoe' } });
    assert.deepEqual([...both.answeredBy].sort(), ['org-manager', 'profile-dept']);
    assert.equal(both.data.org, 'root', "org-manager's claim");
    assert.equal(both.data.department, 'it', "profile-dept's field");
    assert.equal(both.data.displayName, 'Zoe', 'the incoming profile rides through');
    await reg.disable(T, 'profile-dept');
    await bus.host.sync();
    const one = await reg.queryHook<Record<string, unknown>>(T, 'profile.enrich', { tenant: T, subject: 'demo-alice', profile: {} });
    assert.deepEqual(one.answeredBy, ['org-manager']);
    assert.equal(one.data.department, undefined, 'only the plugins that answer appear');
    assert.equal(one.data.org, 'root');
  });

  it('without a bus both controls and queries refuse rather than running locally', async () => {
    const local = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
    local.register(riskGeo); local.register(orgManager);
    await assert.rejects(local.control(T, 'risk.score', {}), (e: PluginError) => e.code === 'bus-unavailable');
    await assert.rejects(local.queryHook(T, 'profile.enrich', {}), (e: PluginError) => e.code === 'bus-unavailable');
  });
});
