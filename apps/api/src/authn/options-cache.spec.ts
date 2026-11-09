import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// Import order matters (loader/registry cycle): the module first, as in the other authn specs.
import '../plugins/v1/plugins-v1.module.js';
import { AuthnService } from './flow.service.js';

/**
 * The public sign-in options cache: keyed on the Dolt head, so repeat visits skip the configuration read and the
 * per-method plugin calls, and any change (Apply, plugin enable/disable) is visible on the very next request.
 * Runs with a fake registry and fake branch registries: no Dolt, no bus.
 */
const T = 'acme-demo';
const config = {
  methods: [{ id: 'pw', type: 'password', name: 'Password', enabled: true, level: 3, config: {} }],
  chains: [{ id: 'c1', name: 'Password only', enabled: true, steps: ['pw'], level: 3 }],
  defaultChain: 'c1',
};

function fakeRegistry(counters: { coreSettings: number; callSlot: number }) {
  const plugin = { manifest: { id: 'auth-password', authMethod: { type: 'password' } } };
  return {
    async coreSettings() { counters.coreSettings++; return config; },
    resolve(_tenant: string, slot: string) { if (slot !== 'auth.password') throw new Error('no provider'); return plugin; },
    isActive() { return true; },
    async callSlot(_t: string, _s: string, hook: string) {
      assert.equal(hook, 'auth.verification');
      counters.callSlot++;
      return { result: { real: true, note: '' } };
    },
  };
}

function fakeBranches(reg: unknown, head: () => string) {
  return { get: async () => reg, headOf: () => head() };
}

describe('sign-in options cache (workspace mode)', () => {
  const saved = process.env.IAM_WORKSPACE_MODE;
  beforeEach(() => { process.env.IAM_WORKSPACE_MODE = '1'; });
  afterEach(() => { if (saved === undefined) delete process.env.IAM_WORKSPACE_MODE; else process.env.IAM_WORKSPACE_MODE = saved; });

  it('serves repeat requests from the cache while the head is unchanged', async () => {
    const counters = { coreSettings: 0, callSlot: 0 };
    const svc = new AuthnService(fakeRegistry(counters) as never, fakeBranches(fakeRegistry(counters), () => 'head-1') as never);
    const first = await svc.options(T), second = await svc.options(T);
    assert.equal(first.mode, 'choice');
    assert.equal(second.chains.length, 1);
    assert.equal(counters.coreSettings, 1, 'the configuration is read once');
    assert.equal(counters.callSlot, 1, 'the method plugin is asked once');
  });

  it('recomputes as soon as the head changes', async () => {
    const counters = { coreSettings: 0, callSlot: 0 };
    let head = 'head-1';
    const reg = fakeRegistry(counters);
    const svc = new AuthnService(reg as never, fakeBranches(reg, () => head) as never);
    await svc.options(T);
    head = 'head-2'; // an Apply or a plugin change moved the branch
    const after = await svc.options(T);
    assert.equal(after.chains.length, 1);
    assert.equal(counters.coreSettings, 2, 'a new head invalidates the cached list');
    assert.equal(counters.callSlot, 2);
  });

  it('keeps tenants and branches apart', async () => {
    const counters = { coreSettings: 0, callSlot: 0 };
    const reg = fakeRegistry(counters);
    const svc = new AuthnService(reg as never, fakeBranches(reg, () => 'head-1') as never);
    await svc.options(T);
    await svc.options('other-tenant');
    await svc.options(T, 'feature-x');
    assert.equal(counters.coreSettings, 3, 'tenant and branch are part of the key');
  });

  it('does not cache outside workspace mode (no head to key on)', async () => {
    delete process.env.IAM_WORKSPACE_MODE;
    const counters = { coreSettings: 0, callSlot: 0 };
    const reg = fakeRegistry(counters);
    const svc = new AuthnService(reg as never);
    await svc.options(T); await svc.options(T);
    assert.equal(counters.coreSettings, 2, 'every request recomputes');
  });
});
