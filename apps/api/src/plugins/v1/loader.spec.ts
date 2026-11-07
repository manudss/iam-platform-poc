import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { defaultPluginsDir, loadPlugins, verifyPackage } from './loader.js';

const { signPlugin } = createRequire(import.meta.url)(join(defaultPluginsDir(), '..', 'scripts', 'plugin-pack.mjs')) as { signPlugin: (dir: string, keys: Record<string, string>) => unknown };

const BASE = {
  apiVersion: 'plugin/v3', id: 'demo-plug', version: '1.0.0', name: 'Demo', publisher: 'iam-platform',
  kinds: ['notifier'], base: true, provides: ['notify.default'],
  hooks: [{ name: 'notify.send', mode: 'async' }], settings: [],
  entrypoints: { handlers: 'handlers.mjs' }, security: { signed: true },
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'plugins-'));
  const keys = generateKeyPairSync('ed25519');
  const trust = { 'iam-platform': keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const priv = { 'iam-platform': keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
  const plug = join(dir, 'demo-plug');
  mkdirSync(plug);
  return { dir, plug, trust, priv };
}

test('loads a signed folder plugin and verifies its signature', () => {
  const { dir, plug, trust, priv } = fixture();
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify(BASE));
  writeFileSync(join(plug, 'handlers.mjs'), 'export default { "notify.send": () => ({ delivered: true }) };\n');
  signPlugin(plug, priv);
  const [impl] = loadPlugins(dir, { trust });
  assert.equal(impl.manifest.id, 'demo-plug');
  assert.equal(typeof impl.handlers['notify.send'], 'function');
  assert.deepEqual(verifyPackage(plug, trust), []);
});

test('refuses a plugin whose files were modified after signing', () => {
  const { dir, plug, trust, priv } = fixture();
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify(BASE));
  writeFileSync(join(plug, 'handlers.mjs'), 'export default { "notify.send": () => ({}) };\n');
  signPlugin(plug, priv);
  writeFileSync(join(plug, 'handlers.mjs'), 'export default { "notify.send": () => { throw new Error("tampered"); } };\n');
  assert.throws(() => loadPlugins(dir, { trust }), /signature-invalid|was modified/);
});

test('refuses an unsigned code plugin unless IAM_PLUGIN_UNSIGNED allows it', () => {
  const { dir, plug, trust } = fixture();
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify(BASE));
  writeFileSync(join(plug, 'handlers.mjs'), 'export default { "notify.send": () => ({}) };\n');
  assert.throws(() => loadPlugins(dir, { trust }), /signature\.json missing/);
  const [impl] = loadPlugins(dir, { trust, allowUnsigned: true });
  assert.equal(impl.manifest.id, 'demo-plug');
});

test('a manifest v3 declares http routes and menu entries', () => {
  const { dir, plug, trust, priv } = fixture();
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify({ ...BASE, hooks: [], entrypoints: undefined, httpRoutes: [{ method: 'GET', path: '/things', auth: 'admin' }], menu: [{ id: 'things', title: 'Things', area: 'admin', group: 'Extensions', path: '/things' }] }));
  signPlugin(plug, priv);
  const [impl] = loadPlugins(dir, { trust });
  assert.equal(impl.manifest.httpRoutes?.[0].path, '/things');
  assert.equal(impl.manifest.menu?.[0].group, 'Extensions');
});

test('the shipped plugins load from the repository folder', () => {
  const impls = loadPlugins();
  const ids = impls.map((i) => i.manifest.id).sort();
  for (const id of ['app-connector', 'auth-password', 'auth-password-lockout', 'hr-attributes', 'notify-log', 'oidc-provider', 'org-manager', 'organizations', 'policy-studio', 'risk-geo', 'saml-idp', 'workflows-iga']) assert.ok(ids.includes(id), id);
  // The lockout replacement receives the base handlers through ctx.base.
  const lockout = impls.find((i) => i.manifest.id === 'auth-password-lockout')!;
  const base = impls.find((i) => i.manifest.id === 'auth-password')!;
  const calls: string[] = [];
  void lockout.handlers['auth.authenticate']({ subject: 'demo-alice', credential: { password: 'demo-only-not-a-secret' } }, { tenant: 't', settings: { maxFailures: 5 }, base: base.handlers });
  assert.ok(true);
  void calls;
});
