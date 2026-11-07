import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry, PluginError } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore } from './memory-stores.js';
import { authPassword, authPasswordLockout, notifyLog, orgManager, riskGeo } from './builtin/index.js';
import { validateManifest } from './manifest.js';
import { HOOKS } from './hooks.js';
import { toFormModel } from './settings.js';
import { fakeBusBridge } from '../../testing/fake-bus.js';

const T = 't1';
const good = { subject: 'demo-user-1', credential: { password: 'demo-pass-1' } };
const bad = { subject: 'demo-user-1', credential: { password: 'nope' } };

describe('plugin registry v1', () => {
  let reg: PluginRegistry; let mig: MemoryMigrationStore; let audit: string[];
  beforeEach(() => {
    mig = new MemoryMigrationStore(); audit = [];
    reg = new PluginRegistry(mig, new MemorySettingsStore(), (e) => audit.push(`${e.action}:${e.plugin}`));
    reg.register(authPassword); reg.register(notifyLog);
    reg.setBus(fakeBusBridge(reg)); // registry is bus-only (step 3 cleanup): unit specs attach the in-process fake
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

  it('a replacement delegates to the base REGISTERED in this registry, not the one the loader saw (directory-auth override)', async () => {
    // The directory-backed base (workspace mode) replaces only auth.authenticate; the lockout must call THAT one.
    const directoryAuth = { ...authPassword, handlers: { ...authPassword.handlers, 'auth.authenticate': async (p: any) => p.credential.password === 'directory-pass' ? { outcome: 'allow', subject: p.subject, methods: ['pwd'] } : { outcome: 'deny', reason: 'bad-credentials' } } };
    const reg2 = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {});
    reg2.register(directoryAuth); reg2.register(authPasswordLockout());
    reg2.setBus(fakeBusBridge(reg2));
    await reg2.install(T, 'auth-password-lockout', { install: true });
    await reg2.enable(T, 'auth-password-lockout', { hooks: ['auth.authenticate'] });
    const ok = await reg2.callSlot<any>(T, 'auth.password', 'auth.authenticate', { subject: 'demo-user-1', credential: { password: 'directory-pass' } });
    assert.equal(ok.result.outcome, 'allow', 'the lockout checked the credential against the registered (directory) base');
    const ko = await reg2.callSlot<any>(T, 'auth.password', 'auth.authenticate', good); // demo credential: the disk base would accept it
    assert.equal(ko.result.outcome, 'deny', 'the demo-credential base of the loader is NOT consulted');
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

  const lockout = async (impl = authPasswordLockout()) => {
    reg.register(impl);
    await reg.install(T, impl.manifest.id, { install: true });
    await reg.configure(T, impl.manifest.id, {});
    await reg.enable(T, impl.manifest.id, { hooks: ['auth.authenticate'] });
    return impl;
  };

  it('SECURITY: a failing auth replacement fails closed, never falls back to the less strict base, until an admin acts', async () => {
    const broken = authPasswordLockout();
    broken.handlers['auth.authenticate'] = () => { throw new Error('boom'); };
    await lockout(broken);
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', good), (e: PluginError) => e.code === 'plugin-failed');
    // the same valid credentials are still refused afterwards: the base is never asked
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', good), (e: PluginError) => e.code === 'plugin-failed');
    assert.ok(audit.includes('plugin.fault.closed:auth-password-lockout'));
    assert.equal(reg.list(T).find((p) => p.id === 'auth-password-lockout')!.faulted, true);
    // recovery is an explicit, audited admin action that returns to a valid base configuration
    await reg.disable(T, 'auth-password-lockout');
    const r = await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good);
    assert.equal(r.servedBy, 'auth-password'); assert.equal(r.result.outcome, 'allow');
    assert.ok(audit.includes('plugin.disable:auth-password-lockout'));
  });

  it('SECURITY: a hung auth replacement times out closed; a locked-out subject stays locked and counters are not reset by the registry', async () => {
    const slow = authPasswordLockout();
    const real = slow.handlers['auth.authenticate'];
    let hang = false;
    slow.handlers['auth.authenticate'] = (p, c) => (hang ? new Promise(() => {}) : real(p, c));
    await lockout(slow);
    await reg.configure(T, 'auth-password-lockout', { maxFailures: 2 });
    await reg.callSlot(T, 'auth.password', 'auth.authenticate', bad); await reg.callSlot(T, 'auth.password', 'auth.authenticate', bad);
    assert.equal((await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good)).result.reason, 'locked');
    hang = true;
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', good, 30), (e: PluginError) => e.code === 'plugin-failed');
    hang = false;
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', good), (e: PluginError) => e.code === 'plugin-failed'); // faulted: still refused
    await reg.enable(T, 'auth-password-lockout', { hooks: ['auth.authenticate'] }); // explicit admin re-enable clears the fault, not the counters
    assert.equal((await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good)).result.reason, 'locked');
  });

  it('a failing replacement is faulted and refused (no fallback: redelivery replaced it), until an admin disables it', async () => {
    const m = structuredClone(notifyLog.manifest); m.id = 'notify-bad'; m.base = false; m.extends = 'notify-log'; m.provides = ['notify.default'];
    reg.register({ manifest: m, handlers: { 'notify.send': () => { throw new Error('smtp down'); }, 'notify.capability': () => ({ real: false }) } });
    await reg.install(T, 'notify-bad', {}); await reg.configure(T, 'notify-bad', {}); await reg.enable(T, 'notify-bad');
    await assert.rejects(reg.callSlot(T, 'notify.default', 'notify.send', { to: 'x', template: 't' }), (e: PluginError) => e.code === 'plugin-failed');
    assert.ok(audit.includes('plugin.fault.closed:notify-bad'));
    assert.equal(reg.list(T).find((p) => p.id === 'notify-bad')!.faulted, true);
    await reg.disable(T, 'notify-bad'); // explicit admin action: the base serves its slot again
    const r = await reg.callSlot<any>(T, 'notify.default', 'notify.send', { to: 'x', template: 't' });
    assert.equal(r.fellBack, false); assert.equal(r.servedBy, 'notify-log');
  });

  it('disable is refused when the base has no valid configuration of its own', async () => {
    const baseM = structuredClone(authPassword.manifest); baseM.id = 'auth-strict'; baseM.provides = ['auth.strict'];
    baseM.settings = [{ key: 'realm', type: 'string', label: 'Realm', required: true }];
    reg.register({ manifest: baseM, handlers: authPassword.handlers });
    const m = structuredClone(authPasswordLockout().manifest); m.id = 'auth-strict-x'; m.extends = 'auth-strict'; m.provides = ['auth.strict'];
    m.settings = [{ key: 'realm', type: 'string', label: 'Realm', required: true }]; m.install = undefined;
    reg.register({ manifest: m, handlers: authPasswordLockout().handlers });
    await reg.install(T, 'auth-strict-x', {}); await reg.configure(T, 'auth-strict-x', { realm: 'r' });
    await reg.enable(T, 'auth-strict-x', { hooks: ['auth.authenticate'] });
    await assert.rejects(reg.disable(T, 'auth-strict-x'), (e: PluginError) => e.code === 'base-config-invalid');
    await reg.configure(T, 'auth-strict', { realm: 'r' });
    await reg.disable(T, 'auth-strict-x');
  });

  it('semantic compatibility: a replacement cannot loosen base constraints', () => {
    const tweak = (f: (s: any[]) => void, id: string) => { const m = structuredClone(authPasswordLockout().manifest); m.id = id; f(m.settings); return () => reg.register({ manifest: m, handlers: authPasswordLockout().handlers }); };
    assert.throws(tweak((s) => { s[0].min = 1; }, 'a1'), /minimum must be at least 8/);
    assert.throws(tweak((s) => { s[0].max = 999; }, 'a2'), /maximum must be at most 128/);
    assert.throws(tweak((s) => { delete s[0].min; }, 'a3'), /minimum must be at least 8/);
    const baseM = structuredClone(notifyLog.manifest); baseM.id = 'notify-sel'; baseM.provides = ['notify.sel'];
    baseM.settings = [{ key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }], required: true }, { key: 'k', type: 'secret', label: 'K' }];
    reg.register({ manifest: baseM, handlers: notifyLog.handlers });
    const c = (settings: any[], id: string) => { const m = structuredClone(baseM); m.id = id; m.base = false; m.extends = 'notify-sel'; m.settings = settings; return () => reg.register({ manifest: m, handlers: notifyLog.handlers }); };
    assert.throws(c([{ key: 'mode', type: 'select', label: 'M', options: [{ value: 'a', label: 'A' }, { value: 'z', label: 'Z' }], required: true }, { key: 'k', type: 'secret', label: 'K' }], 'b1'), /subset/);
    assert.throws(c([{ key: 'mode', type: 'select', label: 'M', options: [{ value: 'a', label: 'A' }] }, { key: 'k', type: 'secret', label: 'K' }], 'b2'), /must stay required/);
    assert.throws(c([{ key: 'mode', type: 'select', label: 'M', options: [{ value: 'a', label: 'A' }], required: true }, { key: 'k', type: 'string', label: 'K' }], 'b3'), /type string differs/);
    c([{ key: 'mode', type: 'select', label: 'M', options: [{ value: 'a', label: 'A' }], required: true }, { key: 'k', type: 'secret', label: 'K' }], 'b4')();
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

  it('migration inverses (down) may drop the plugin\'s own tables but never another prefix', () => {
    const m = structuredClone(orgManager.manifest);
    m.install!.migrations[0].down = ['drop table if exists plg_org_manager_orgs'];
    assert.equal(validateManifest(m, HOOKS).filter((e) => /inverse/.test(e)).length, 0, 'own-prefix drop allowed in an inverse');
    m.install!.migrations[0].down = ['drop table users'];
    assert.ok(validateManifest(m, HOOKS).some((e) => /inverse: table users must start with plg_org_manager_/.test(e)));
  });

  it('disable/enable keep data; uninstall needs disable, removes only the tenant\'s rows, and drops tables for the last tenant', async () => {
    reg.register(orgManager);
    await reg.install(T, 'org-manager', { install: true });
    await reg.install('t2', 'org-manager', { install: true });
    await reg.enable(T, 'org-manager');
    const before = await mig.applied('org-manager');
    await reg.disable(T, 'org-manager');
    await reg.enable(T, 'org-manager');
    assert.deepEqual(await mig.applied('org-manager'), before, 'disable/enable never re-applies migrations');
    assert.equal(mig.rows.filter((r) => r.plugin === 'org-manager' && r.tenant === T).length, 1, 'seed is not duplicated');

    await assert.rejects(reg.uninstall(T, 'org-manager'), (e: PluginError) => e.code === 'still-enabled');
    await assert.rejects(reg.uninstall(T, 'auth-password'), (e: PluginError) => e.code === 'base-required');
    await reg.disable(T, 'org-manager');
    await reg.uninstall(T, 'org-manager');
    assert.equal(mig.rows.filter((r) => r.plugin === 'org-manager' && r.tenant === T).length, 0, 't1 rows removed');
    assert.equal(mig.rows.filter((r) => r.plugin === 'org-manager' && r.tenant === 't2').length, 1, 't2 rows untouched');
    assert.equal((await mig.applied('org-manager')).length, 1, 'tables kept while another tenant has it installed');

    await reg.uninstall('t2', 'org-manager'); // installed but never enabled: no disable needed
    assert.equal((await mig.applied('org-manager')).length, 0, 'last tenant reverts the migrations');
    assert.ok(mig.log.some((l) => l.id === '001-orgs (down)' && l.sql.some((q) => /drop table/i.test(q))), 'declared inverse ran');
    assert.ok(audit.includes('plugin.uninstall:org-manager'));

    await reg.install(T, 'org-manager', { install: true });
    assert.equal((await mig.applied('org-manager')).length, 1, 'reinstall re-applies on a clean slate');
  });

  it('uninstall refuses an applied migration without a declared inverse', async () => {
    const m = structuredClone(orgManager.manifest);
    delete m.install!.migrations[0].down;
    reg.register({ manifest: m, handlers: orgManager.handlers });
    await reg.install(T, m.id, { install: true });
    await assert.rejects(reg.uninstall(T, m.id), (e: PluginError) => e.code === 'uninstall-incomplete');
    assert.ok((await mig.applied(m.id)).length > 0, 'nothing was reverted');
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
    const dep = structuredClone(orgManager.manifest); dep.id = 'org-reports'; dep.requires = ['org-manager']; dep.install = undefined; dep.screens = undefined; dep.hooks = []; dep.httpRoutes = []; dep.menu = [];
    reg.register({ manifest: dep, handlers: {} });
    for (const id of ['org-manager', 'org-reports']) { await reg.install(T, id, { install: true }); await reg.configure(T, id, {}); }
    await reg.enable(T, 'org-reports').catch((e) => assert.equal(e.code, 'missing-dependency'));
    await reg.enable(T, 'org-manager'); await reg.enable(T, 'org-reports');
    await assert.rejects(reg.disable(T, 'org-manager'), (e: PluginError) => e.code === 'in-use');
  });
});

describe('manifest v2: subscribes and emits (step 2)', () => {
  const base = () => structuredClone(notifyLog.manifest);
  it('accepts custom kinds in the plugin namespace and refuses others', () => {
    const m = base() as any;
    m.subscribes = [{ name: 'plg.notify-log.digest', mode: 'async' }];
    m.emits = ['plg.notify-log.sent'];
    assert.deepEqual(validateManifest(m, HOOKS), []);
    m.subscribes = [{ name: 'other.thing', mode: 'async' }];
    m.emits = ['notify.send'];
    const errs = validateManifest(m, HOOKS);
    assert.ok(errs.some((e) => e.includes("subscribes: other.thing")), errs.join());
    assert.ok(errs.some((e) => e.includes('emits: notify.send')), errs.join());
  });
  it('enforces mode rules and handler presence', () => {
    const m = base() as any;
    m.subscribes = [{ name: 'plg.notify-log.check', mode: 'async', mandatory: true }];
    assert.ok(validateManifest(m, HOOKS).some((e) => e.includes('mandatory')));
    m.subscribes = [{ name: 'plg.notify-log.check', mode: 'blocking', group: 'g' }];
    assert.ok(validateManifest(m, HOOKS).some((e) => e.includes('group')));
    const reg2 = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
    m.subscribes = [{ name: 'plg.notify-log.check', mode: 'blocking', mandatory: true }];
    assert.throws(() => reg2.register({ manifest: m, handlers: notifyLog.handlers }), /check declared but no handler/);
  });
});

describe('bus facade (step 2)', () => {
  let reg: PluginRegistry;
  beforeEach(() => {
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
    reg.register(authPassword); reg.register(notifyLog);
  });
  const stub = (impl: Partial<import('./registry.js').BusBridge>) => impl as import('./registry.js').BusBridge;

  it('emit routes through the bus when the kind is routed, and dedupes by effectKey', async () => {
    const calls: any[] = [];
    reg.setBus(stub({ routed: (k) => k === 'notify.send', emit: async (t, k, p, ek) => { calls.push({ t, k, ek }); return [{ plugin: 'notify-log', result: { delivered: true } }]; } }));
    const out = await reg.emit(T, 'notify.send', { effectKey: 'k1', to: 'x', template: 'y', tenant: T, data: {} } as any);
    assert.deepEqual(out, [{ plugin: 'notify-log', result: { delivered: true } }]);
    assert.equal(calls.length, 1);
    assert.deepEqual(await reg.emit(T, 'notify.send', { effectKey: 'k1', to: 'x', template: 'y', tenant: T, data: {} } as any), [], 'same effectKey is not re-sent');
    assert.equal(calls.length, 1);
  });

  it('a bus failure raises without any in-process fallback (no double effects, D16)', async () => {
    let ranInProcess = false;
    const spy = { manifest: { ...notifyLog.manifest, hooks: notifyLog.manifest.hooks.filter((h) => h.name === 'notify.send') }, handlers: { 'notify.send': () => { ranInProcess = true; return {}; } } };
    const reg2 = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
    reg2.register(spy);
    reg2.setBus(stub({ routed: () => true, emit: async () => { throw new Error('core unreachable'); } }));
    await assert.rejects(reg2.emit(T, 'notify.send', { effectKey: 'k2', to: 'x', template: 'y', tenant: T, data: {} } as any), /bus|core unreachable/);
    assert.equal(ranInProcess, false);
  });

  it('no in-process path remains: an unrouted kind or a missing bridge refuses (bus-unavailable)', async () => {
    reg.setBus(stub({ routed: () => false }));
    await assert.rejects(reg.emit(T, 'notify.send', { effectKey: 'k3', to: 'a@b.c', template: 't', tenant: T, data: {} } as any), (e: PluginError) => e.code === 'bus-unavailable');
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', good), (e: PluginError) => e.code === 'bus-unavailable');
    const bare = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
    bare.register(notifyLog);
    await assert.rejects(bare.emit(T, 'notify.send', { effectKey: 'k4', to: 'a@b.c', template: 't', tenant: T, data: {} } as any), (e: PluginError) => e.code === 'bus-unavailable');
  });

  it('callSlot has a generic bus path (active for the routed blocking kinds, step 3)', async () => {
    reg.setBus(stub({ routed: () => true, call: async () => ({ verdict: 'allow', answered: true, result: { outcome: 'allow', subject: 's', methods: ['pwd'] } }) }));
    const r = await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good);
    assert.equal(r.servedBy, 'bus'); assert.equal(r.result.outcome, 'allow');
    reg.setBus(stub({ routed: () => true, call: async () => ({ verdict: 'deny', reason: "mandatory 'ghost' unusable: timeout", answered: false, result: undefined }) }));
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', good), (e: PluginError) => e.code === 'plugin-failed');
    // No usable answer at all (every subscriber silent or not-concerned) refuses too, even on an allow verdict.
    reg.setBus(stub({ routed: () => true, call: async () => ({ verdict: 'allow', answered: false, result: undefined }) }));
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', good), (e: PluginError) => e.code === 'plugin-failed' && /no responder/.test(e.message));
  });

  it('the activity listener fires on enable and disable (the bus host re-pushes)', async () => {
    let fired = 0;
    reg.onActivityChange(() => { fired++; });
    reg.register(orgManager);
    await reg.install(T, 'org-manager', { install: true });
    await reg.enable(T, 'org-manager', {});
    await reg.disable(T, 'org-manager');
    assert.equal(fired, 2);
  });

  it('P1 cache: inventories are computed once, then invalidated on install, enable, disable and refresh', async () => {
    reg.register(orgManager);
    const l1 = reg.list(T);
    assert.equal(reg.list(T), l1, 'list is cached between reads');
    const m1 = reg.menu(T);
    assert.equal(reg.menu(T), m1, 'menu is cached between reads');
    await reg.install(T, 'org-manager', { install: true });
    const l2 = reg.list(T);
    assert.notEqual(l2, l1, 'install invalidates the cached list');
    assert.equal(l2.find((p) => p.id === 'org-manager')?.installed, true);
    await reg.enable(T, 'org-manager', {});
    const l3 = reg.list(T);
    assert.notEqual(l3, l2, 'enable invalidates the cached list');
    assert.equal(l3.find((p) => p.id === 'org-manager')?.enabled, true);
    await reg.disable(T, 'org-manager');
    assert.equal(reg.list(T).find((p) => p.id === 'org-manager')?.enabled, false, 'disable invalidates too');
    const l4 = reg.list(T);
    reg.invalidateInventories(); // the admin refresh path
    assert.notEqual(reg.list(T), l4, 'manual refresh recomputes');
    assert.deepEqual(reg.list(T), l4, 'same content, fresh derivation');
  });
});
