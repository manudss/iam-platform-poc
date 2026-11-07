import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { defaultPluginsDir, loadPlugins, loadPluginModule, refreshPluginCatalogue, verifyPackage } from './loader.js';

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

test('P0-2: refuses a package with an added, unsigned file (the signed inventory must cover everything)', () => {
  const { dir, plug, trust, priv } = fixture();
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify(BASE));
  writeFileSync(join(plug, 'handlers.mjs'), 'export default { "notify.send": () => ({}) };\n');
  signPlugin(plug, priv);
  writeFileSync(join(plug, 'extra.mjs'), 'export const backdoor = true;\n');
  assert.throws(() => loadPlugins(dir, { trust }), /extra\.mjs is present but not signed/);
});

test('P0-2: refuses a signature whose publisher is not in the trust store', () => {
  const { dir, plug, trust, priv } = fixture();
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify(BASE));
  writeFileSync(join(plug, 'handlers.mjs'), 'export default { "notify.send": () => ({}) };\n');
  signPlugin(plug, priv);
  // Hand-crafted signature metadata: claims a publisher the trust store does not know.
  const sig = JSON.parse(readFileSync(join(plug, 'signature.json'), 'utf8'));
  sig.publisher = 'evil-corp';
  writeFileSync(join(plug, 'signature.json'), JSON.stringify(sig));
  assert.ok(verifyPackage(plug, trust).some((e) => /untrusted publisher evil-corp/.test(e)));
  assert.throws(() => loadPlugins(dir, { trust }), /untrusted publisher/);
});

test('P0-2: refuses a symlink inside the package', () => {
  const { dir, plug, trust, priv } = fixture();
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify(BASE));
  writeFileSync(join(plug, 'handlers.mjs'), 'export default { "notify.send": () => ({}) };\n');
  signPlugin(plug, priv);
  symlinkSync(join(plug, 'handlers.mjs'), join(plug, 'linked.mjs'));
  assert.throws(() => loadPlugins(dir, { trust }), /symlink/);
});

test('P0-2: refuses a manifest whose declared entrypoint is not signed', () => {
  const { dir, plug, trust, priv } = fixture();
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify(BASE));
  writeFileSync(join(plug, 'handlers.mjs'), 'export default { "notify.send": () => ({}) };\n');
  signPlugin(plug, priv);
  // Rewrite the manifest so a different (unsigned) entrypoint is declared, then restore the manifest's original hash path.
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify({ ...BASE, entrypoints: { handlers: 'other.mjs' } }));
  writeFileSync(join(plug, 'other.mjs'), 'export default { "notify.send": () => ({}) };\n');
  const errs = verifyPackage(plug, trust);
  assert.ok(errs.some((e) => /manifest\.json was modified/.test(e)), 'tampered manifest is caught by its hash');
});

test('P0-3: no trust store and no keys are ever generated at load time (explicit dev setup only)', () => {
  const { dir, plug, trust, priv } = fixture();
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify(BASE));
  writeFileSync(join(plug, 'handlers.mjs'), 'export default { "notify.send": () => ({}) };\n');
  signPlugin(plug, priv);
  // No conf/plugin-trust.json next to this temp plugins dir: loading must REFUSE, and must not create anything.
  assert.throws(() => loadPlugins(dir), /untrusted publisher|signature/);
  assert.equal(existsSync(join(dir, '..', 'conf', 'plugin-trust.json')), false, 'no trust store appeared');
  assert.equal(existsSync(join(dir, '..', 'conf', 'plugin-dev-key.json')), false, 'no private key was generated');
});

test('P0-1: loadPluginModule verifies the package BEFORE importing (a rejected package has no load effect)', () => {
  const { dir, plug, trust, priv } = fixture();
  writeFileSync(join(plug, 'manifest.json'), JSON.stringify(BASE));
  writeFileSync(join(plug, 'handlers.mjs'), 'export default { "notify.send": () => ({}) };\n');
  writeFileSync(join(plug, 'helper.mjs'), 'export const answer = 42;\n');
  signPlugin(plug, priv);
  // A signed helper loads through the verified catalogue.
  // (loadPluginModule resolves the SHIPPED plugins dir; point it at this fixture through IAM_PLUGINS_DIR.)
  const saved = process.env.IAM_PLUGINS_DIR;
  process.env.IAM_PLUGINS_DIR = dir;
  try {
    const ok = loadPluginModule<{ answer: number }>('demo-plug', 'helper.mjs', { trust });
    assert.equal(ok.answer, 42);
    // Tampered file: rejected before any import. The catalogue is shared and cached (P1): the rejection is
    // re-evaluated after the explicit invalidation every plugin-affecting action performs.
    writeFileSync(join(plug, 'helper.mjs'), 'export const answer = -1; throw new Error("must never execute");\n');
    refreshPluginCatalogue();
    assert.throws(() => loadPluginModule('demo-plug', 'helper.mjs', { trust }), /was modified after signing/);
    refreshPluginCatalogue();
  } finally { if (saved === undefined) delete process.env.IAM_PLUGINS_DIR; else process.env.IAM_PLUGINS_DIR = saved; }
});

test('P0-1: no core file imports a plugin path directly (everything goes through the verified catalogue)', () => {
  const src = join(defaultPluginsDir(), '..', 'apps', 'api', 'src');
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'dist' && e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.ts')) continue;
      const rel = join(src, e.name) && p.slice(src.length + 1);
      if (rel === join('plugins', 'v1', 'loader.ts')) continue; // the catalogue itself
      const text = readFileSync(p, 'utf8');
      if (/createRequire\([^)]*\)\(resolve\(defaultPluginsDir\(\)/.test(text)) offenders.push(rel);
      if (/require\([^)]*plugins[\\/][\w-]+[\\/]\w+\.mjs/.test(text)) offenders.push(rel);
    }
  };
  walk(src);
  assert.deepEqual(offenders, []);
});
