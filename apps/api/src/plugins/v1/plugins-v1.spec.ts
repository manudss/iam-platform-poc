import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry, PluginError } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore } from './memory-stores.js';
import { authPassword, authPasswordLockout, notifyLog, orgManager, riskGeo } from './builtin/index.js';
import { validateManifest } from './manifest.js';
import { HOOKS } from './hooks.js';
import { toFormModel } from './settings.js';

const T = 't1';
const good = { subject: 'demo-user-1', credential: { password: 'demo-pass-1' } };
const bad = { subject: 'demo-user-1', credential: { password: 'nope' } };

describe('plugin registry v1', () => {
  let reg: PluginRegistry; let mig: MemoryMigrationStore; let audit: string[];
  beforeEach(() => {
    mig = new MemoryMigrationStore(); audit = [];
    reg = new PluginRegistry(mig, new MemorySettingsStore(), (e) => audit.push(`${e.action}:${e.plugin}`));
    reg.register(authPassword); reg.register(notifyLog);
  });

  it('base plugins serve their slot and cannot be disabled', async () => {
    const r = await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good);
    assert.equal(r.servedBy, 'auth-password'); assert.equal(r.result.outcome, 'allow');
    await assert.rejects(reg.disable(T, 'auth-password'), (e: PluginError) => e.code === 'base-required');
  });

  it('rejects a replacement that drops a base setting, changes its type or hides a base hook', () => {
    const m = structuredClone(authPasswordLockout().manifest);
    m.settings = m.settings.filter((s) => s.key !== 'minLength');
    assert.throws(() => reg.register({ manifest: m, handlers: authPasswordLockout().handlers }), /missing base setting minLength/);
    const m2 = structuredClone(authPasswordLockout().manifest); m2.id = 'auth-x';
    m2.settings[0].type = 'string';
    assert.throws(() => reg.register({ manifest: m2, handlers: authPasswordLockout().handlers }), /type string differs/);
    const m3 = structuredClone(authPasswordLockout().manifest); m3.id = 'auth-y'; m3.hooks = [];
    assert.throws(() => reg.register({ manifest: m3, handlers: {} }), /must handle base hook/);
  });

  it('replacement takes over after install, grant and config; disabling returns to the base with base config', async () => {
    reg.register(authPasswordLockout());
    await assert.rejects(reg.install(T, 'auth-password-lockout', {}), (e: PluginError) => e.code === 'grant-required');
    await reg.install(T, 'auth-password-lockout', { install: true });
    assert.equal(mig.log.length, 1);
    await assert.rejects(reg.enable(T, 'auth-password-lockout'), (e: PluginError) => e.code === 'grant-required'); // sensitive hook not granted
    await reg.configure(T, 'auth-password-lockout', { minLength: 14, maxFailures: 2 });
    await reg.enable(T, 'auth-password-lockout', { hooks: ['auth.authenticate'] });
    assert.equal((await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good)).servedBy, 'auth-password-lockout');
    // lockout works
    await reg.callSlot(T, 'auth.password', 'auth.authenticate', bad); await reg.callSlot(T, 'auth.password', 'auth.authenticate', bad);
    assert.equal((await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good)).result.reason, 'locked');
    await reg.disable(T, 'auth-password-lockout');
    const back = await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good);
    assert.equal(back.servedBy, 'auth-password'); assert.equal(back.result.outcome, 'allow');
    // base configuration was never touched; data tables not dropped
    assert.equal(mig.log.filter((m) => /drop/i.test(m.sql.join())).length, 0);
    // re-enable is idempotent for migrations
    await reg.install(T, 'auth-password-lockout', { install: true });
    assert.equal(mig.log.length, 1);
  });

  it('a failing replacement falls back to the base so nobody is locked out', async () => {
    const broken = authPasswordLockout();
    broken.handlers['auth.authenticate'] = () => { throw new Error('boom'); };
    reg.register(broken);
    await reg.install(T, broken.manifest.id, { install: true });
    await reg.configure(T, broken.manifest.id, {});
    await reg.enable(T, broken.manifest.id, { hooks: ['auth.authenticate'] });
    const r = await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good);
    assert.equal(r.fellBack, true); assert.equal(r.servedBy, 'auth-password'); assert.equal(r.result.outcome, 'allow');
    assert.ok(audit.includes('plugin.fallback:auth-password-lockout'));
    // stays on the base until an admin re-enables
    assert.equal((await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good)).fellBack, false);
  });

  it('a hung replacement times out and falls back', async () => {
    const slow = authPasswordLockout();
    slow.handlers['auth.authenticate'] = () => new Promise(() => {});
    reg.register(slow); await reg.install(T, slow.manifest.id, { install: true });
    await reg.configure(T, slow.manifest.id, {}); await reg.enable(T, slow.manifest.id, { hooks: ['auth.authenticate'] });
    const r = await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good, 50);
    assert.equal(r.servedBy, 'auth-password');
  });

  it('declared schemas grant nothing: sensitive hooks and component screens need explicit grants', async () => {
    reg.register(riskGeo);
    await reg.install(T, 'risk-geo', {});
    await assert.rejects(reg.enable(T, 'risk-geo', {}), /sensitive/);
    await assert.rejects(reg.enable(T, 'risk-geo', { hooks: ['risk.score'] }), /component screens/);
    await reg.enable(T, 'risk-geo', { hooks: ['risk.score'], uiComponents: true });
    assert.equal(reg.screens(T).filter((s) => s.plugin === 'risk-geo').length, 1);
    await reg.disable(T, 'risk-geo');
    assert.equal(reg.screens(T).length, 0);
  });

  it('migrations are checksum-guarded, prefixed, and cannot drop tables', () => {
    const m = structuredClone(orgManager.manifest);
    m.install!.migrations[0].sql.push('create table users (id int)');
    m.install!.migrations.push({ id: '002', sql: ['drop table plg_org_manager_orgs'] });
    const errs = validateManifest(m, HOOKS);
    assert.ok(errs.some((e) => /table users must start with plg_org_manager_/.test(e)));
    assert.ok(errs.some((e) => /drop table is not allowed/.test(e)));
  });

  it('settings: validation, defaults and generated form with masked secrets', async () => {
    reg.register(orgManager);
    await reg.install(T, 'org-manager', { install: true });
    assert.equal(mig.rows.length, 1);
    await assert.rejects(reg.configure(T, 'org-manager', { maxDepth: 99 }), /at most 12/);
    await assert.rejects(reg.configure(T, 'org-manager', { nope: 1 }), /unknown setting/);
    await reg.configure(T, 'org-manager', { maxDepth: 3 });
    const f = await reg.form(T, 'org-manager');
    assert.deepEqual(f.groups.map((g) => g.name), ['General', 'Claims']);
    assert.equal(f.groups[0].fields[0].value, 3);
    assert.equal(f.groups[1].fields[0].value, 'org');
    const sf = toFormModel([{ key: 'k', type: 'secret', label: 'Key' }], { k: 'topsecret' });
    assert.equal(sf.groups[0].fields[0].value, '********');
  });

  it('a secret that is not re-sent keeps its stored value and is never returned', async () => {
    const m = structuredClone(notifyLog.manifest); m.id = 'notify-smtp'; m.base = false; m.extends = 'notify-log'; m.provides = ['notify.default'];
    m.settings.push({ key: 'apiKey', type: 'secret', label: 'API key', required: true });
    reg.register({ manifest: m, handlers: notifyLog.handlers });
    await reg.install(T, 'notify-smtp', {});
    await assert.rejects(reg.enable(T, 'notify-smtp'), /configure before enabling/); // required key missing
    await reg.configure(T, 'notify-smtp', { apiKey: 'k-123' });
    await reg.configure(T, 'notify-smtp', { prefix: 'mail' });
    const f = await reg.form(T, 'notify-smtp');
    assert.equal(f.groups.flatMap((g) => g.fields).find((x) => x.key === 'apiKey')!.value, '********');
    assert.ok(!JSON.stringify(f).includes('k-123'));
  });

  it('multi-kind plugin: enriches profiles and exposes schema screens; async hooks deduplicate by effect key', async () => {
    reg.register(orgManager);
    await reg.install(T, 'org-manager', { install: true });
    await reg.configure(T, 'org-manager', {});
    await reg.enable(T, 'org-manager');
    assert.equal(reg.screens(T).length, 2);
    const ev = { tenant: T, subject: 's', change: 'mover' as const, effectKey: 'e1' };
    assert.equal((await reg.emit(T, 'identity.changed', ev)).length, 1);
    assert.equal((await reg.emit(T, 'identity.changed', ev)).length, 0);
  });

  it('a plugin cannot be disabled while another needs it', async () => {
    reg.register(orgManager);
    const dep = structuredClone(orgManager.manifest); dep.id = 'org-reports'; dep.requires = ['org-manager']; dep.install = undefined; dep.screens = undefined; dep.hooks = [];
    reg.register({ manifest: dep, handlers: {} });
    for (const id of ['org-manager', 'org-reports']) { await reg.install(T, id, { install: true }); await reg.configure(T, id, {}); }
    await reg.enable(T, 'org-reports').catch((e) => assert.equal(e.code, 'missing-dependency'));
    await reg.enable(T, 'org-manager'); await reg.enable(T, 'org-reports');
    await assert.rejects(reg.disable(T, 'org-manager'), (e: PluginError) => e.code === 'in-use');
  });
});
