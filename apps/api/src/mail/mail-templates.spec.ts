import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { MailTemplatesService, MemoryMailTemplateStore } from './mail-templates.js';
import { loadPlugins } from '../plugins/v1/loader.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from '../plugins/v1/memory-stores.js';
import { fakeBusBridge } from '../testing/fake-bus.js';

// Mail template management: the catalogue merged with the branch customization, validation, preview, send-test.
describe('mail templates management', () => {
  let reg: PluginRegistry, svc: MailTemplatesService;
  before(async () => {
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {}, new MemoryStateStore());
    for (const p of loadPlugins()) reg.register(p);
    await reg.load();
    reg.setBus(fakeBusBridge(reg));
    svc = new MailTemplatesService(new MemoryMailTemplateStore(), reg);
  });

  it('lists the catalogue with the defaults effective and nothing customized', async () => {
    const list = await svc.list('t1');
    assert.equal(list[0].key, '_layout');
    const code = list.find((x) => x.key === 'sign-in-code')!;
    assert.equal(code.customized, false);
    assert.match(code.effective.subject!, /Your sign-in code/);
  });

  it('saves, applies and restores a customization; unknown variables are refused', async () => {
    await assert.rejects(() => svc.put('t1', 'admin', 'sign-in-code', { subject: 'Hi {{nope}}', text: 'x' }), /unknown variable/);
    await assert.rejects(() => svc.put('t1', 'admin', 'sign-in-code', { subject: '', text: 'x' }), /subject is required/);
    await assert.rejects(() => svc.put('t1', 'admin', 'unknown-key', { subject: 'a', text: 'b' }), /unknown mail template/);
    const d = await svc.put('t1', 'admin', 'sign-in-code', { subject: 'Code {{code}}', text: 'use {{code}} within {{ttlMinutes}} min', html: '<p>{{code}}</p>' });
    assert.equal(d.customized, true);
    assert.equal(d.override?.subject, 'Code {{code}}');
    const preview = await svc.preview('t1', { key: 'sign-in-code', data: { code: '111', ttlMinutes: 5, subjectUser: 'u' } });
    assert.equal(preview.subject, 'Code 111');
    const restored = await svc.restore('t1', 'admin', 'sign-in-code');
    assert.equal(restored.customized, false);
  });

  it('the layout keeps {{body}} and carries its variables', async () => {
    await assert.rejects(() => svc.put('t1', 'admin', '_layout', { html: '<p>no placeholder</p>' }), /\{\{body\}\}/);
    await svc.put('t1', 'admin', '_layout', { html: '<main>{{body}}</main><footer>{{footer}}</footer>', vars: { footer: 'ACME' } });
    const preview = await svc.preview('t1', { key: 'role.changed', data: { subject: 'u1', role: 'admin', change: 'granted', activation: 7 } });
    assert.match(preview.html!, /^<main>/);
    assert.match(preview.html!, /<footer>ACME<\/footer>/);
    await svc.restore('t1', 'admin', '_layout');
  });

  it('send-test renders and emits through the slot', async () => {
    const r = await svc.sendTest('t1', 'admin', 'workflow.notify', { to: 'admin@example.org' });
    assert.equal(r.sent, true);
    assert.equal(r.real, false); // notify-log is simulated
    assert.equal(r.to, 'admin@example.org');
    await assert.rejects(() => svc.sendTest('t1', 'admin', 'workflow.notify', { to: 'nope' }), /recipient/);
  });
});
