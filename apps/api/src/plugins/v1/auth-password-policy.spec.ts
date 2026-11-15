import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { PluginRegistry, PluginError } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore } from './memory-stores.js';
import { authPassword, authPasswordLockout } from './builtin/index.js';
import { pluginCatalogue } from './loader.js';
import { fakeBusBridge } from '../../testing/fake-bus.js';

/**
 * auth-password-policy: the advanced password policy replacement of the auth.password slot.
 *  - the policy decides at creation/change (auth.password.validate): length, classes, denied content, reuse history;
 *  - expiry is enforced at sign-in (auth.authenticate) from the change date the core passes;
 *  - the slot contract holds: grants are required, disabling returns to the base rule, a fault fails closed.
 */
const T = 't1';
const policy = () => pluginCatalogue().get('auth-password-policy')!;
const hash = (pwd: string, salt: string) => scryptSync(pwd, salt, 64).toString('hex');
const hist = (entries: [string, number][]) => entries.map(([pwd, at], i) => { const salt = `ab${i}`.repeat(24).slice(0, 48); return { salt, hash: hash(pwd, salt), at }; });
const NOW = 1_800_000_000_000;

describe('auth-password-policy (advanced password policy replacement)', () => {
  let reg: PluginRegistry;
  beforeEach(() => {
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {});
    reg.register(authPassword); reg.register(authPasswordLockout());
    reg.setBus(fakeBusBridge(reg));
  });
  const enable = async (settings: Record<string, unknown> = {}, impl = policy()) => {
    reg.register(impl);
    await reg.install(T, 'auth-password-policy', {});
    if (Object.keys(settings).length) await reg.configure(T, 'auth-password-policy', settings);
    await reg.enable(T, 'auth-password-policy', { hooks: ['auth.authenticate', 'auth.password.validate'] });
    return impl;
  };
  const validate = (candidate: string, extra: Record<string, unknown> = {}) =>
    reg.callSlot<any>(T, 'auth.password', 'auth.password.validate', { tenant: T, subject: 'demo-user-1', candidate, now: NOW, ...extra });

  it('is a valid replacement: the sensitive hooks need grants, then the slot is served by the policy plugin', async () => {
    reg.register(policy());
    await reg.install(T, 'auth-password-policy', {});
    await assert.rejects(reg.enable(T, 'auth-password-policy'), (e: PluginError) => e.code === 'grant-required');
    await assert.rejects(reg.enable(T, 'auth-password-policy', { hooks: ['auth.authenticate'] }), (e: PluginError) => e.code === 'grant-required');
    await reg.enable(T, 'auth-password-policy', { hooks: ['auth.authenticate', 'auth.password.validate'] });
    assert.equal((await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', { tenant: T, subject: 'demo-user-1', credential: { password: 'demo-pass-1' } })).servedBy, 'auth-password-policy');
  });

  it('the base rule applies with no replacement, and comes back on disable', async () => {
    assert.equal((await validate('short')).result.ok, false);
    assert.equal((await validate('a-long-enough-password')).result.ok, true);
    await enable({ minLength: 24 });
    assert.equal((await validate('a-long-enough-password')).result.ok, false); // 22 < 24 under the policy
    await reg.disable(T, 'auth-password-policy');
    assert.equal((await validate('a-long-enough-password')).result.ok, true); // base rule again
  });

  it('length, required classes and min classes are configurable and reported as readable errors', async () => {
    await enable({ minLength: 10, maxLength: 20, requireDigit: true, requireUpper: true, minClasses: 3 });
    const r = await validate('alllowercase');
    assert.equal(r.result.ok, false);
    const msg = r.result.errors.join('; ');
    assert.ok(msg.includes('uppercase') && msg.includes('digit') && msg.includes('3 of the 4'), msg);
    assert.equal((await validate('Abcdefgh1j')).result.ok, true);
    assert.equal((await validate('Abcdefgh1j' + 'x'.repeat(11))).result.ok, false); // 21 > maxLength
  });

  it('denied content: login, name, e-mail, forbidden words and the common list', async () => {
    await enable({ minLength: 8, forbidUserInfo: true, forbiddenWords: ['acme'], blockCommon: true });
    const info = { userInfo: { login: 'demo-user-1', displayName: 'Alice Martin', email: 'alice@example.com' } };
    assert.equal((await validate('xxAlice99xx', info)).result.ok, false);
    assert.equal((await validate('qqalice@example.com', info)).result.ok, false);
    assert.equal((await validate('demo-user-1!!', info)).result.ok, false);
    assert.equal((await validate('my-acme-pass', info)).result.ok, false);
    assert.equal((await validate('password', info)).result.ok, false); // common list
    assert.equal((await validate('sup3r-uniqu3', info)).result.ok, true);
  });

  it('reuse history: the current password is always refused, older ones up to historyCount', async () => {
    await enable({ minLength: 8, historyCount: 2 });
    const history = hist([['current-pw', NOW - 1_000], ['older-pw', NOW - 2_000], ['oldest-pw', NOW - 3_000], ['ancient-pw', NOW - 4_000]]);
    const r = await validate('current-pw', { history });
    assert.equal(r.result.ok, false); assert.ok(r.result.errors.join(' ').includes('already used'));
    assert.equal((await validate('older-pw', { history })).result.ok, false);
    assert.equal((await validate('oldest-pw', { history })).result.ok, false); // current + 2 previous are refused
    assert.equal((await validate('ancient-pw', { history })).result.ok, true); // beyond historyCount = 2
    assert.equal((await validate('brand-new-pw', { history })).result.ok, true);
    // A malformed history entry is skipped, never a crash nor an accept-all.
    assert.equal((await validate('brand-new-pw', { history: [{ salt: 1, hash: null }, ...history] })).result.ok, true);
  });

  it('expiry: an expired password is refused at sign-in with its reason audited, a fresh one passes through to the base', async () => {
    await enable({ maxAgeDays: 30 });
    const cred = { password: 'demo-pass-1' };
    const fresh = await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', { tenant: T, subject: 'demo-user-1', credential: cred, passwordChangedAt: NOW - 10 * 86_400_000, now: NOW });
    assert.equal(fresh.result.outcome, 'allow');
    const old = await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', { tenant: T, subject: 'demo-user-1', credential: cred, passwordChangedAt: NOW - 31 * 86_400_000, now: NOW });
    assert.equal(old.result.outcome, 'deny'); assert.equal(old.result.reason, 'password-expired');
    // No change date known (password set before the history existed): not blocked, the rule applies from the next change.
    assert.equal((await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', { tenant: T, subject: 'demo-user-1', credential: cred, now: NOW })).result.outcome, 'allow');
    // A wrong password is still just denied.
    assert.equal((await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', { tenant: T, subject: 'demo-user-1', credential: { password: 'nope' }, now: NOW })).result.outcome, 'deny');
  });

  it('a faulting replacement fails closed on the policy hook too (the base is NOT asked)', async () => {
    const p = policy();
    p.handlers['auth.password.validate'] = () => { throw new Error('policy store down'); };
    await enable({}, p);
    await assert.rejects(validate('whatever-password'), (e: PluginError) => e.code === 'plugin-failed');
    await assert.rejects(validate('whatever-password'), (e: PluginError) => e.code === 'plugin-failed'); // faulted: refused again
    await reg.disable(T, 'auth-password-policy'); // explicit admin recovery: the base rule answers again
    assert.equal((await validate('whatever-password')).result.ok, true);
  });
});
