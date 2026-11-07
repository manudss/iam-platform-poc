import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins } from './loader.js';
import { PluginRegistry } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from './memory-stores.js';
import { validateSettings } from './settings.js';

// notify-resend: real delivery through the Resend HTTPS API (key from RESEND_API_KEY only), log fallback in dev.
describe('notify-resend plugin', () => {
  let reg: PluginRegistry;
  before(async () => {
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {}, new MemoryStateStore());
    for (const p of loadPlugins()) reg.register(p);
    await reg.load();
    await reg.install('t1', 'notify-resend', {});
    await reg.enable('t1', 'notify-resend', {});
  });
  after(() => { delete process.env.RESEND_API_KEY; });
  const call = async (payload: Record<string, unknown>) => {
    const impl = reg.resolve('t1', 'notify.default');
    assert.equal(impl.manifest.id, 'notify-resend'); // the replacement serves the slot
    const settings = validateSettings(impl.manifest.settings, (await reg.settingsFor('t1', 'notify-resend')) ?? {}).values;
    const base = reg.impl('notify-log')!.handlers;
    return impl.handlers['notify.send'](payload, { tenant: 't1', settings, base });
  };
  it('falls back to the base log transport without RESEND_API_KEY', async () => {
    delete process.env.RESEND_API_KEY;
    assert.deepEqual(await call({ tenant: 't1', to: 'manager-of:u1', template: 'role.changed', data: { role: 'admin' }, effectKey: 'k1' }), { delivered: false, line: 'notify: role.changed -> manager-of:u1' });
  });
  it('sends through the Resend API when the key is configured', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const sent: { url: string; body: { from: string; to: string; subject: string; text: string } }[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: { body?: string } = {}) => { sent.push({ url: String(url), body: JSON.parse(init.body ?? '{}') }); return new Response(JSON.stringify({ id: 'mail_1' }), { status: 200 }); }) as typeof fetch;
    try {
      assert.deepEqual(await call({ tenant: 't1', to: 'a@b.example', template: 'role.changed', data: { role: 'admin' }, effectKey: 'k2' }), { delivered: true, id: 'mail_1' });
      assert.equal(sent[0].body.from, 'lyam@dss.name');
      assert.equal(sent[0].body.to, 'a@b.example');
      assert.match(sent[0].body.text, /role: admin/);
    } finally { globalThis.fetch = prev; }
  });
});
