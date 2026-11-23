import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from '../plugins/v1/memory-stores.js';
import { shippedPlugins } from '../plugins/v1/builtin/index.js';
import { AppConnectorService, MemoryAppConnectorStore } from './app-connector.js';
import { branchContext } from '../workspace/context.js';

// liveApps is documented "as they are LIVE (Dolt main)": it must serve from the LIVE (main) registry even
// while the request carries a working branch. Regression: the connector enabled on main but not on the
// person's selected branch made My applications answer 500 (no-provider from the branch's refusing base)
// although the live inventory was enabled.
const T = 'acme-demo';
const buildRegistry = async () => {
  const reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {}, new MemoryStateStore());
  for (const p of shippedPlugins()) reg.register(p);
  await reg.load();
  return reg;
};

describe('liveApps: the live inventory ignores the request working branch', () => {
  const saved = process.env.IAM_WORKSPACE_MODE;
  before(() => { process.env.IAM_WORKSPACE_MODE = '1'; });
  after(() => { if (saved === undefined) delete process.env.IAM_WORKSPACE_MODE; else process.env.IAM_WORKSPACE_MODE = saved; });

  it('serves the live apps with a branch selected whose registry has no enabled connector', async () => {
    const main = await buildRegistry(), work = await buildRegistry();
    await main.install(T, 'app-connector', {}); await main.enable(T, 'app-connector', {});
    // 'work' deliberately has no app-connector: a working branch before any Apply.
    const branches = { get: async (ref: string) => (ref === 'main' ? main : work) };
    const profile = { pluginActive: async (t: string, id: string, ref: 'live' | 'work') => main.isActive(t, id) };
    const store = new MemoryAppConnectorStore();
    const svc = new AppConnectorService(profile as never, store, main, branches as never);
    await store.write(T, 'admin', (s) => { s.apps.push({ id: 'wiki', name: 'Company wiki', description: '', protocol: 'oidc', enabled: true, redirect_uris: [], entity_id: null, acs_url: null, attribute_mapping: {}, allowed_roles: [], secret_ref: null, launch_url: 'https://wiki.example.invalid/', sp_certificate: null, want_signed_requests: false, nameid_format: null, scopes: ['profile'], allow_refresh_tokens: true, logo: null }); });
    assert.equal((await svc.liveApps(T)).length, 1, 'no branch context: the main registry serves');
    const onBranch = await branchContext.run({ branch: 'personal/alice' }, () => svc.liveApps(T));
    assert.equal(onBranch.length, 1, 'a selected working branch must not break the live inventory');
    assert.equal(onBranch[0].id, 'wiki');
  });

  it('branch-scoped administration still resolves on the working branch', async () => {
    const main = await buildRegistry(), work = await buildRegistry();
    await work.install(T, 'app-connector', {}); await work.enable(T, 'app-connector', {});
    const branches = { get: async (ref: string) => (ref === 'main' ? main : work) };
    const profile = { pluginActive: async (t: string, id: string, ref: 'live' | 'work') => (ref === 'live' ? main : work).isActive(t, id) };
    const svc = new AppConnectorService(profile as never, new MemoryAppConnectorStore(), main, branches as never);
    const listed = await branchContext.run({ branch: 'personal/alice' }, () => svc.list(T));
    assert.deepEqual(listed.apps, [], 'list() runs on the branch registry (empty there), unchanged by the live fix');
  });
});
