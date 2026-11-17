import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePluginSecrets } from './secret-store.js';
import { PluginRegistry } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore } from './memory-stores.js';

/**
 * Secret settings (a provider clientSecret) never touch Dolt: configure splits them to the secret store,
 * the versioned settings row stays free of them, reads merge them back for the runtime, and the console
 * form still shows a mask. A legacy row written before the split is scrubbed by the next configure.
 */

const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
function secretsFile() { const d = mkdtempSync(join(tmpdir(), 'iam-secrets-')); tmp.push(d); return join(d, 'secrets.json'); }

const manifest = {
  id: 'auth-sso-test', name: 'Test SSO', version: '1.0.0', api: 1,
  apiVersion: 'plugin/v3', publisher: 'iam-platform', kinds: ['auth-method'],
  provides: ['auth.external.test'], hooks: [],
  settings: [
    { key: 'clientId', label: 'Client ID', type: 'string', required: false },
    { key: 'clientSecret', label: 'Client secret', type: 'secret', required: false },
  ],
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const impl = { manifest, handlers: {} } as any;

function registry(secretsPath: string) {
  const settings = new MemorySettingsStore();
  const reg = new PluginRegistry(new MemoryMigrationStore(), settings, () => {}, undefined, new FilePluginSecrets(secretsPath));
  reg.register(impl);
  return { reg, settings };
}

describe('plugin secret storage', () => {
  it('file store round-trips and writes 0600', async () => {
    const path = secretsFile();
    const s = new FilePluginSecrets(path);
    await s.put('t1', 'auth-sso-test', 'clientSecret', 'unit-test-value');
    assert.equal(await s.get('t1', 'auth-sso-test', 'clientSecret'), 'unit-test-value');
    assert.equal(await new FilePluginSecrets(path).get('t1', 'auth-sso-test', 'clientSecret'), 'unit-test-value');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(await s.get('t1', 'auth-sso-test', 'missing'), undefined);
  });

  it('configure keeps the secret out of the versioned settings store', async () => {
    const { reg, settings } = registry(secretsFile());
    await reg.configure('t1', 'auth-sso-test', { clientId: 'id-1', clientSecret: 'unit-test-secret' });
    const row = (await settings.get('t1', 'auth-sso-test'))!;
    assert.equal(row.clientId, 'id-1');
    assert.equal('clientSecret' in row, false, 'secret must not be in the versioned row');
    assert.equal(JSON.stringify(row).includes('unit-test-secret'), false);
    // Runtime reads merge it back; the console form only shows a mask.
    assert.equal((await reg.settingsFor('t1', 'auth-sso-test'))!.clientSecret, 'unit-test-secret');
    const form = await reg.form('t1', 'auth-sso-test');
    const field = form.groups.flatMap((g) => g.fields).find((f) => f.key === 'clientSecret')!;
    assert.equal(field.value, '********');
  });

  it('a secret that is not re-sent keeps its stored value', async () => {
    const { reg, settings } = registry(secretsFile());
    await reg.configure('t1', 'auth-sso-test', { clientId: 'id-1', clientSecret: 'unit-test-secret' });
    await reg.configure('t1', 'auth-sso-test', { clientId: 'id-2' });
    assert.equal((await settings.get('t1', 'auth-sso-test'))!.clientId, 'id-2');
    assert.equal((await reg.settingsFor('t1', 'auth-sso-test'))!.clientSecret, 'unit-test-secret');
  });

  it('the next configure scrubs a legacy plaintext secret from the versioned row', async () => {
    const { reg, settings } = registry(secretsFile());
    // Simulate a row written before the split: secret sitting in the versioned store.
    await settings.put('t1', 'auth-sso-test', { clientId: 'id-1', clientSecret: 'legacy-value' });
    // Legacy reads still work (the runtime must not break before the next configure).
    assert.equal((await reg.settingsFor('t1', 'auth-sso-test'))!.clientSecret, 'legacy-value');
    await reg.configure('t1', 'auth-sso-test', { clientId: 'id-2' });
    const row = (await settings.get('t1', 'auth-sso-test'))!;
    assert.equal('clientSecret' in row, false, 'legacy secret scrubbed');
    assert.equal((await reg.settingsFor('t1', 'auth-sso-test'))!.clientSecret, 'legacy-value');
  });

  it('audit lines never name a secret key', async () => {
    const audited: string[] = [];
    const settings = new MemorySettingsStore();
    const reg = new PluginRegistry(new MemoryMigrationStore(), settings, (e) => audited.push(`${e.action}:${e.detail ?? ''}`), undefined, new FilePluginSecrets(secretsFile()));
    reg.register(impl);
    await reg.configure('t1', 'auth-sso-test', { clientId: 'id-1', clientSecret: 'unit-test-secret' });
    assert.ok(audited.some((l) => l.includes('plugin.configure')));
    assert.equal(audited.join('\n').includes('clientSecret'), false);
  });
});
