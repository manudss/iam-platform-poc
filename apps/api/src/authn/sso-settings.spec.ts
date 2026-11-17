import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthnService } from './flow.service.js';
import { PluginRegistry, PluginImpl } from '../plugins/v1/registry.js';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from '../plugins/v1/memory-stores.js';
import { FilePluginSecrets } from '../plugins/v1/secret-store.js';
import { defaultPluginsDir } from '../plugins/v1/loader.js';
import { CORE_SETTINGS_ID, parseStored, validateConfig } from './config.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Social provider settings (docs/sso-federation.md rule 5). Regression pins from the PR100 preview review:
 * - the four NAMED providers (one provider project per environment) are plugin-scoped: the administrator sets
 *   client id/secret ONCE on the plugin (Plugins > Settings or the method's Edit drawer), the New-instance
 *   form never re-asks them and the instance config never carries them (a secret in the versioned config
 *   would land in Dolt);
 * - the GENERIC OIDC provider stays instance-scoped (several providers, one instance each), so its secret
 *   setting is split out of the versioned config into the plugin secret store, masked in the console read;
 * - openid-client is a runtime dependency: the demo image prunes devDependencies, so the OIDC exchange
 *   library must not be one (the PR100 preview 503'd at the provider callback exactly this way).
 */
const T = 'acme-demo';
const MASK = '********';

async function loadReal(id: string): Promise<PluginImpl> {
  const dir = join(defaultPluginsDir(), id);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const mod = await import(pathToFileURL(join(dir, manifest.entrypoints.handlers)).href);
  return { manifest, handlers: typeof mod.default === 'function' ? mod.default() : mod.default };
}

async function setup() {
  const secrets = new FilePluginSecrets(join(mkdtempSync(join(tmpdir(), 'sso-secrets-')), 's.json'));
  const reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {}, new MemoryStateStore(), secrets);
  for (const id of ['auth-sso-google-base', 'auth-sso-google', 'auth-sso-oidc-base', 'auth-sso-oidc']) reg.register(await loadReal(id));
  const svc = new AuthnService(reg);
  return { reg, svc, secrets };
}

const oidcInstance = (clientSecret: unknown) => ({
  id: 'oidc1', type: 'sso-oidc', name: 'Fictional IdP', enabled: true, level: 6,
  config: { providerName: 'Fictional IdP', issuer: 'https://idp.example.test', authorizeEndpoint: 'https://idp.example.test/auth', tokenEndpoint: 'https://idp.example.test/token', jwksUri: 'https://idp.example.test/jwks', clientId: 'fictional-oidc-client', scopes: 'openid email', ...(clientSecret !== undefined ? { clientSecret } : {}) },
});

describe('social provider settings scope', () => {
  it('the four named providers are plugin-scoped; the generic OIDC provider stays instance-scoped', async () => {
    for (const id of ['auth-sso-google', 'auth-sso-microsoft', 'auth-sso-facebook', 'auth-sso-github']) {
      assert.equal((await loadReal(id)).manifest.authMethod?.settingsScope, 'plugin', id);
    }
    assert.notEqual((await loadReal('auth-sso-oidc')).manifest.authMethod?.settingsScope, 'plugin', 'generic OIDC: several providers, one instance each');
  });

  it('openid-client is a runtime dependency (the demo image prunes devDependencies)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.ok(pkg.dependencies?.['openid-client'], 'federation.ts imports openid-client at the provider callback: it must survive npm prune --omit=dev');
  });

  it('validateConfig strips every plugin-scoped setting from the instance config', async () => {
    const cfg = validateConfig({
      methods: [{ id: 'goog', type: 'sso-google', name: 'Google', enabled: true, level: 6, config: { clientId: 'fictional-client', clientSecret: 'fictional-secret', hostedDomain: 'example.test' } }],
      chains: [], defaultChain: null,
    });
    assert.deepEqual(cfg.methods[0].config, {}, 'a plugin-scoped method never carries provider settings in the versioned config');
  });

  it('the console form of a plugin-scoped method masks the stored secret and the mask never overwrites it', async () => {
    const { reg, svc } = await setup();
    await reg.install(T, 'auth-sso-google', {});
    await reg.enable(T, 'auth-sso-google', { hooks: ['auth.external.start', 'auth.external.verify'], uiComponents: true });
    await reg.configure(T, 'auth-sso-google', { clientId: 'fictional-client', clientSecret: 'fictional-secret' });
    await svc.saveConfig(T, { methods: [{ id: 'goog', type: 'sso-google', name: 'Google', enabled: true, level: 6, config: {} }], chains: [], defaultChain: null });

    const serving = await svc.servingSettings(T, validateConfig({ methods: [{ id: 'goog', type: 'sso-google', name: 'Google', enabled: true, level: 6, config: {} }], chains: [], defaultChain: null }));
    assert.equal(serving.goog.values.clientId, 'fictional-client');
    assert.equal(serving.goog.values.clientSecret, MASK, 'the console only ever receives a mask');

    await svc.saveServingSettings(T, 'goog', { clientId: 'fictional-client', clientSecret: MASK, hostedDomain: 'example.test' });
    assert.equal((await reg.settingsFor(T, 'auth-sso-google'))?.clientSecret, 'fictional-secret', 'a re-sent mask keeps the stored secret');
    assert.equal((await reg.settingsFor(T, 'auth-sso-google'))?.hostedDomain, 'example.test');
  });

  it('an instance-scoped secret is split out of the versioned config, masked on read, kept on a masked re-save, cleared on empty', async () => {
    const { reg, svc, secrets } = await setup();
    await svc.saveConfig(T, { methods: [oidcInstance('fictional-oidc-secret')], chains: [], defaultChain: null });
    const stored = parseStored(await reg.coreSettings(T, CORE_SETTINGS_ID))!;
    assert.equal(stored.methods[0].config.clientSecret, undefined, 'the versioned config never holds the secret');
    assert.equal(stored.methods[0].config.clientId, 'fictional-oidc-client');
    assert.equal(await secrets.get(T, 'auth-sso-oidc', 'oidc1.clientSecret'), 'fictional-oidc-secret');

    const shown = await svc.consoleConfig(T);
    assert.equal(shown.methods[0].config.clientSecret, MASK, 'the console read masks the stored secret');
    assert.equal(shown.methods[0].config.clientId, 'fictional-oidc-client');

    await svc.saveConfig(T, { methods: [oidcInstance(MASK)], chains: [], defaultChain: null });
    assert.equal(await secrets.get(T, 'auth-sso-oidc', 'oidc1.clientSecret'), 'fictional-oidc-secret', 'a masked round-trip keeps the secret');
    assert.equal((await svc.consoleConfig(T)).methods[0].config.clientSecret, MASK);

    await svc.saveConfig(T, { methods: [oidcInstance('')], chains: [], defaultChain: null });
    assert.equal((await svc.consoleConfig(T)).methods[0].config.clientSecret, undefined, 'an empty value clears the secret');
  });
});
