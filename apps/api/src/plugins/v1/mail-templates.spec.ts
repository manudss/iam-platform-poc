import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins } from './loader.js';
import { PluginRegistry } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from './memory-stores.js';
import { fakeBusBridge } from '../../testing/fake-bus.js';
import { mailCatalogue, mailTemplateDecl, mailLayoutDecl, renderMail, renderMailOrLegacy } from './mail-catalogue.js';
import { validateManifest } from './manifest.js';
import { HOOKS } from './hooks.js';

// mail-templates: the catalogue declared in manifests, the notify.templates slot render, the layout wrapping.
describe('mail templates', () => {
  let reg: PluginRegistry;
  before(async () => {
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {}, new MemoryStateStore());
    for (const p of loadPlugins()) reg.register(p);
    await reg.load();
    reg.setBus(fakeBusBridge(reg));
  });

  it('the catalogue lists every declared mail type, layout first', () => {
    const keys = mailCatalogue().map((x) => x.decl.key);
    assert.equal(keys[0], '_layout');
    for (const k of ['sign-in-code', 'signup-confirmation', 'role.changed', 'workflow.notify']) assert.ok(keys.includes(k), `missing ${k}`);
    assert.equal(mailTemplateDecl('sign-in-code')?.plugin, 'auth-email-otp');
    assert.equal(mailTemplateDecl('signup-confirmation')?.plugin, 'directory');
    assert.equal(mailLayoutDecl()?.plugin, 'mail-templates-base');
    assert.equal(mailTemplateDecl('nope'), undefined);
  });

  it('the base plugin serves the notify.templates slot', () => {
    assert.equal(reg.resolve('t1', 'notify.templates').manifest.id, 'mail-templates-base');
  });

  it('renders a declared template through the slot, escaped and wrapped in the layout', async () => {
    const r = await renderMail(reg, 't1', 'sign-in-code', { code: '482916', ttlMinutes: 5, subjectUser: 'demo-<alice>' });
    assert.ok(r);
    assert.equal(r.subject, 'Your sign-in code: 482916');
    assert.match(r.text, /code is 482916/);
    assert.match(r.text, /-- lyam - identity & access demo/); // the layout footer joins the text body
    assert.match(r.html!, /<strong>482916<\/strong>/);
    assert.match(r.html!, /demo-&lt;alice&gt;/); // data escaped in HTML
    assert.match(r.html!, /background:#f1f5f9/); // wrapped in the default layout
    assert.match(r.html!, />lyam<\/h1>/);
  });

  it('a branch override wins over the declared default', async () => {
    const r = await renderMail(reg, 't1', 'sign-in-code', { code: '1', ttlMinutes: 5, subjectUser: 'u' }, { override: { subject: 'Custom {{code}}', text: 'custom {{code}}', html: '<b>{{code}}</b>' } });
    assert.equal(r?.subject, 'Custom 1');
    assert.match(r?.text ?? '', /custom 1/);
    assert.match(r?.html ?? '', /<b>1<\/b>/);
  });

  it('a layout override changes the shell; logoUrl becomes an image', async () => {
    const r = await renderMail(reg, 't1', 'role.changed', { subject: 'u1', role: 'admin', change: 'granted', activation: 7 },
      { layoutOverride: { vars: { logoUrl: 'https://example.org/logo.png', brandColor: '#ff0000' } } });
    assert.match(r?.html ?? '', /<img src="https:\/\/example\.org\/logo\.png"/);
    assert.match(r?.html ?? '', /#ff0000/);
  });

  it('unknown keys render nothing; a renderer problem degrades to legacy (never blocks a send)', async () => {
    assert.equal(await renderMail(reg, 't1', 'unknown-key', {}), undefined);
    const bare = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {}, new MemoryStateStore()); // no bus: every call refuses
    assert.equal(await renderMailOrLegacy(bare, 't1', 'sign-in-code', { code: '1' }), undefined);
  });

  it('manifest validation accepts the decls and rejects bad ones', () => {
    const good = loadPlugins().find((p) => p.manifest.id === 'mail-templates-base')!.manifest;
    assert.deepEqual(validateManifest(good, HOOKS), []);
    const bad = { ...good, mailTemplates: [{ key: 'x', name: '', variables: [], default: { subject: 1 } }] };
    const errs = validateManifest(bad as never, HOOKS);
    assert.ok(errs.some((e) => e.includes('name is required')));
    assert.ok(errs.some((e) => e.includes('default.subject')));
    const badLayout = { ...good, mailTemplates: [{ key: 'x', name: 'X', layout: true, variables: [], default: { subject: '', text: '' } }] };
    assert.ok(validateManifest(badLayout as never, HOOKS).some((e) => e.includes('reserved for the _layout')));
  });
});
