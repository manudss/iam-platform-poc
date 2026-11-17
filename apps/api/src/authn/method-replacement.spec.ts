import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthnService } from './flow.service.js';
import { PluginRegistry, PluginImpl } from '../plugins/v1/registry.js';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from '../plugins/v1/memory-stores.js';
import { defaultPluginsDir } from '../plugins/v1/loader.js';
import { CORE_SETTINGS_ID } from './config.js';

/**
 * A replacement of a WORKING sign-in method serves it transparently (tout-plugin decision: the base is the
 * slot, the replacement is the behaviour). A base like auth-password IS the method (it declares `authMethod`);
 * a plugin that extends it (password lockout, advanced password policy) keeps the same method available as
 * soon as it is enabled - no reconfiguration, methods and chains untouched. The other shipped pattern stays
 * untouched: a REFUSING base (auth-totp-base and friends) declares no `authMethod`, so its method is available
 * only while a real method plugin is enabled on the slot.
 *
 * Regression: provider() used to require the resolved plugin's own `authMethod` declaration, so enabling the
 * lockout/policy replacement resolved the slot to a plugin without one and every password method and chain
 * turned "plugin not active" - exactly what enabling a replacement must never do.
 *
 * Bus-free on purpose: availability and the offered-chains list never call a hook (a degraded verification
 * note is caught inside the service), so the rule is pinned here without nats/core; the full sign-in through
 * the bus is covered by method-plugins.spec.ts.
 */
const T = 'acme-demo';

/** Registers a shipped folder plugin without the signature dance: the spec pins registry semantics, not packaging. */
async function loadReal(id: string): Promise<PluginImpl> {
  const dir = join(defaultPluginsDir(), id);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const mod = await import(pathToFileURL(join(dir, manifest.entrypoints.handlers)).href);
  return { manifest, handlers: typeof mod.default === 'function' ? mod.default() : mod.default };
}

const cfg = () => ({
  methods: [
    { id: 'pw', type: 'password', name: 'Password', enabled: true, level: 3, config: {} },
    { id: 'tp', type: 'totp', name: 'Authenticator app', enabled: true, level: 7, config: {} },
  ],
  chains: [
    { id: 'password-only', name: 'Password only', enabled: true, steps: ['pw'], level: 3 },
    { id: 'pw-totp', name: 'Password then authenticator', enabled: true, steps: ['pw', 'tp'], level: 8 },
  ],
  defaultChain: 'pw-totp',
});

async function setup() {
  const reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {}, new MemoryStateStore());
  reg.register(await loadReal('auth-password')); // base that IS the password method
  reg.register(await loadReal('auth-password-lockout')); // replacement without its own authMethod
  reg.register(await loadReal('auth-totp-base')); // refusing base of the other pattern
  const svc = new AuthnService(reg);
  await reg.putCoreSettings(T, CORE_SETTINGS_ID, cfg() as unknown as Record<string, unknown>);
  return { reg, svc };
}

describe('a replacement of a working sign-in method serves it transparently', () => {
  it('methods and chains survive enabling and disabling the replacement, with no reconfiguration', async () => {
    const { reg, svc } = await setup();

    // Baseline: the base serves the password method; the refusing TOTP base is not a method.
    let avail = await svc.availability(T, cfg());
    assert.deepEqual(avail.methods.pw, { available: true, plugin: 'auth-password' });
    assert.equal(avail.methods.tp.available, false, 'a refusing base without an enabled method plugin is not a provider');
    assert.deepEqual((await svc.options(T)).chains.map((c) => c.id), ['password-only']);

    // Enabling the replacement must NOT retire the method: same entries available and offered, served by it now.
    await reg.install(T, 'auth-password-lockout', { install: true });
    await reg.enable(T, 'auth-password-lockout', { hooks: ['auth.authenticate', 'auth.password.validate'] });
    avail = await svc.availability(T, cfg());
    assert.deepEqual(avail.methods.pw, { available: true, plugin: 'auth-password-lockout' }, 'the replacement serves the method, transparently');
    assert.equal(avail.chains['password-only'].available, true);
    assert.equal(avail.chains['pw-totp'].available, false, 'an unrelated missing plugin still retires its own chain only');
    assert.deepEqual((await svc.options(T)).chains.map((c) => c.id), ['password-only'], 'the chain stays offered at sign-in');

    // Disabling returns to the base with its own configuration: still available, still offered.
    await reg.disable(T, 'auth-password-lockout');
    avail = await svc.availability(T, cfg());
    assert.deepEqual(avail.methods.pw, { available: true, plugin: 'auth-password' });
    assert.deepEqual((await svc.options(T)).chains.map((c) => c.id), ['password-only']);
  });

  it('a faulted replacement stays the provider (fail closed): the method never falls back to the base by itself', async () => {
    const { reg, svc } = await setup();
    await reg.install(T, 'auth-password-lockout', { install: true });
    await reg.enable(T, 'auth-password-lockout', { hooks: ['auth.authenticate', 'auth.password.validate'] });
    await reg.markFaulted(T, 'auth-password-lockout', 'test fault');
    const avail = await svc.availability(T, cfg());
    assert.deepEqual(avail.methods.pw, { available: true, plugin: 'auth-password-lockout' }, 'still the chosen provider: sign-in fails closed instead of degrading to the laxer base');
  });
});
