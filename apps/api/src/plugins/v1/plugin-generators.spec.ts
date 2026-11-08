import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, after } from 'node:test';
import { defaultPluginsDir } from './loader.js';

/** Step 5 acceptance: the generators scaffold a plugin that is COMPLETE for the current contract -
 *  manifest + handlers + the plugin's own package.json (step 4) - and the extend generator produces a
 *  replacement whose handlers delegate to its base. Generators write to a throwaway plugins root
 *  (IAM_PLUGINS_DIR) so the spec never pollutes the repo's real plugins/ the other specs enumerate. */
const root = resolve(defaultPluginsDir(), '..');
const tmp = mkdtempSync(join(tmpdir(), 'plugin-gen-'));
const run = (script: string, args: string[]) =>
  execFileSync(process.execPath, [resolve(root, 'scripts', script), ...args], {
    env: { ...process.env, IAM_PLUGINS_DIR: tmp },
    encoding: 'utf8',
  }).trim();
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('plugin generators (step 5 acceptance)', () => {
  it('1. plugin-create scaffolds manifest, handlers AND the plugin package.json', () => {
    const out = run('plugin-create.mjs', ['spec-notifier', '--name', 'Spec notifier', '--kind', 'notifier', '--hook', 'notify.send']);
    assert.match(out, /created plugins\/spec-notifier/);
    const manifest = JSON.parse(readFileSync(join(tmp, 'spec-notifier/manifest.json'), 'utf8'));
    assert.equal(manifest.apiVersion, 'plugin/v3');
    assert.deepEqual(manifest.kinds, ['notifier']);
    assert.deepEqual(manifest.hooks, [{ name: 'notify.send', mode: 'async' }]);
    const pkg = JSON.parse(readFileSync(join(tmp, 'spec-notifier/package.json'), 'utf8'));
    assert.equal(pkg.name, '@iam-plugin/spec-notifier');
    assert.deepEqual(pkg.dependencies, {});
  });

  it('2. the scaffolded handlers module loads and implements exactly the declared hooks', async () => {
    const mod = (await import(pathToFileURL(join(tmp, 'spec-notifier/handlers.mjs')).href)).default;
    assert.deepEqual(Object.keys(mod), ['notify.send']);
    const result = await mod['notify.send']({ template: 'welcome' }, {});
    assert.deepEqual(result, { received: 'welcome' });
  });

  it('3. plugin-extend scaffolds a base replacement that delegates and owns the base deps', async () => {
    cpSync(join(defaultPluginsDir(), 'auth-totp-base'), join(tmp, 'auth-totp-base'), { recursive: true });
    run('plugin-extend.mjs', ['auth-totp-base', 'spec-totp']);
    const manifest = JSON.parse(readFileSync(join(tmp, 'spec-totp/manifest.json'), 'utf8'));
    assert.equal(manifest.extends, 'auth-totp-base');
    assert.equal(manifest.base, false);
    assert.equal(manifest.install, undefined);
    const base = JSON.parse(readFileSync(join(tmp, 'auth-totp-base/manifest.json'), 'utf8'));
    for (const h of base.hooks) assert.ok(manifest.hooks.some((x: { name: string }) => x.name === h.name), `replacement keeps hook ${h.name}`);
    const mod = (await import(pathToFileURL(join(tmp, 'spec-totp/handlers.mjs')).href)).default;
    const baseCalls: [string, unknown[]][] = [];
    const ctx = { base: Object.fromEntries(base.hooks.map((h: { name: string }) => [h.name, (...a: unknown[]) => baseCalls.push([h.name, a])])) };
    for (const h of base.hooks) mod[h.name]({ probe: true }, ctx);
    assert.deepEqual(baseCalls.map(([n]) => n), base.hooks.map((h: { name: string }) => h.name));
    const pkg = JSON.parse(readFileSync(join(tmp, 'spec-totp/package.json'), 'utf8'));
    assert.equal(pkg.name, '@iam-plugin/spec-totp');
    const basePkg = JSON.parse(readFileSync(join(tmp, 'auth-totp-base/package.json'), 'utf8'));
    assert.deepEqual(pkg.dependencies, basePkg.dependencies);
  });
});
