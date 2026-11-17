import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry, callbackUrl } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore } from './memory-stores.js';
import { FilePluginSecrets } from './secret-store.js';
import { validateManifest } from './manifest.js';
import { HOOKS } from './hooks.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The manifest-declared setup guide rides the form model with the callback URL computed for the environment:
 * the explicit IAM_EXTERNAL_CALLBACK_URL wins, the console's own origin is the fallback. */

const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const manifest = {
  id: 'auth-sso-guided', name: 'Guided SSO', version: '1.0.0', api: 1,
  apiVersion: 'plugin/v3', publisher: 'iam-platform', kinds: ['auth-method'],
  provides: ['auth.external.guided'], hooks: [],
  settings: [
    { key: 'clientId', label: 'Client ID', type: 'string', required: false },
    { key: 'clientSecret', label: 'Client secret', type: 'secret', required: false },
  ],
  setupGuide: {
    intro: 'Leave the Client ID empty for demo mode.',
    steps: ['Open the {console} and create a client.', '{callback}', 'Paste the values below.'],
    consoleUrl: 'https://console.example.com', consoleLabel: 'Example console', docsUrl: 'https://docs.example.com/create',
  },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const impl = { manifest, handlers: {} } as any;

function registry() {
  const d = mkdtempSync(join(tmpdir(), 'iam-guide-')); tmp.push(d);
  const reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {}, undefined, new FilePluginSecrets(join(d, 's.json')));
  reg.register(impl);
  return reg;
}

describe('plugin setup guide', () => {
  it('the form model carries the guide with the computed callback URL (request origin)', async () => {
    delete process.env.IAM_EXTERNAL_CALLBACK_URL;
    const m = await registry().form('t1', 'auth-sso-guided', 'https://iam-pr100.onrender.com');
    assert.equal(m.guide?.consoleUrl, 'https://console.example.com');
    assert.equal(m.guide?.steps.length, 3);
    assert.equal(m.guide?.callbackUrl, 'https://iam-pr100.onrender.com/authorize/external/callback');
  });

  it('IAM_EXTERNAL_CALLBACK_URL wins over the request origin', async () => {
    process.env.IAM_EXTERNAL_CALLBACK_URL = 'https://env.example.com/authorize/external/callback';
    try {
      const m = await registry().form('t1', 'auth-sso-guided', 'https://ignored.example.com');
      assert.equal(m.guide?.callbackUrl, 'https://env.example.com/authorize/external/callback');
      assert.equal(callbackUrl('https://x.example.com'), 'https://env.example.com/authorize/external/callback');
    } finally { delete process.env.IAM_EXTERNAL_CALLBACK_URL; }
  });

  it('no env and no origin falls back to localhost; a plugin without a guide gets none', async () => {
    delete process.env.IAM_EXTERNAL_CALLBACK_URL;
    assert.equal(callbackUrl(undefined), 'http://localhost:8080/authorize/external/callback');
    const reg = registry();
    const plain = structuredClone(manifest) as Record<string, unknown>;
    plain.id = 'auth-sso-plain'; plain.provides = ['auth.external.plain']; delete plain.setupGuide;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reg.register({ manifest: plain, handlers: {} } as any);
    assert.equal((await reg.form('t1', 'auth-sso-plain')).guide, undefined);
  });

  it('manifest validation rejects a broken guide', () => {
    const bad = structuredClone(manifest) as Record<string, unknown>;
    bad.setupGuide = { intro: '', steps: [], consoleUrl: 'http://not-https', consoleLabel: '' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errs = validateManifest(bad as any, HOOKS);
    assert.ok(errs.some((e) => e.includes('setupGuide.intro')));
    assert.ok(errs.some((e) => e.includes('setupGuide.steps')));
    assert.ok(errs.some((e) => e.includes('setupGuide.consoleUrl')));
    assert.ok(errs.some((e) => e.includes('setupGuide.consoleLabel')));
  });
});
