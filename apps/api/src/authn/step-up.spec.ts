import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adminReachability, chainOptions, methodEnrolled, checkAssurance, eligibleChains, sameAccount, type ChainOption } from './step-up.js';

const c = (id: string, level: number, o: Partial<ChainOption> = {}): ChainOption => ({ id, name: id, enabled: true, effectiveLevel: level, simulated: false, enrolled: true, ...o });

describe('assurance check', () => {
  it('no requirement: open', () => assert.equal(checkAssurance(undefined, { minLevel: 0 }, 0).ok, true));
  it('a lower level is refused with the levels', () => assert.deepEqual(checkAssurance({ level: 3, authTime: 0 }, { minLevel: 8 }, 1), { ok: false, code: 'step-up-required', reason: 'level', requiredLevel: 8, currentLevel: 3 }));
  it('a missing session counts as level 0', () => assert.equal(checkAssurance(undefined, { minLevel: 1 }, 0).ok, false));
  it('equal or higher passes', () => { assert.equal(checkAssurance({ level: 8, authTime: 0 }, { minLevel: 8 }, 1).ok, true); assert.equal(checkAssurance({ level: 9, authTime: 0 }, { minLevel: 8 }, 1).ok, true); });
  it('an old sign-in fails the freshness rule even at the right level', () => {
    assert.equal(checkAssurance({ level: 9, authTime: 0 }, { minLevel: 8, maxAgeMs: 1000 }, 2000).ok, false);
    assert.equal(checkAssurance({ level: 9, authTime: 1500 }, { minLevel: 8, maxAgeMs: 1000 }, 2000).ok, true);
  });
  it('a non-numeric level is level 0', () => assert.equal(checkAssurance({ level: NaN, authTime: 0 }, { minLevel: 1 }, 1).ok, false));
});

describe('which chains are offered', () => {
  it('never offers a weaker, disabled, simulated or not enrolled chain', () => {
    const r = eligibleChains([c('pw', 3), c('pk', 9), c('tot', 8), c('off', 9, { enabled: false }), c('sim', 9, { simulated: true }), c('noenrol', 9, { enrolled: false })], 8);
    assert.deepEqual(r.map((x) => x.id), ['tot', 'pk']);
  });
  it('nothing eligible gives an empty list (the screen then explains, no weaker option)', () => assert.deepEqual(eligibleChains([c('pw', 3)], 8), []));
});

describe('same account and admin reachability', () => {
  it('refuses a different account', () => { assert.equal(sameAccount('a', 'a'), true); assert.equal(sameAccount('a', 'b'), false); assert.equal(sameAccount('', ''), false); });
  it('refuses a level no administrator can reach', () => {
    const r = adminReachability({ root: [c('pw', 3)], ann: [c('pw', 3), c('pk', 9, { enrolled: false })] }, 8);
    assert.equal(r.ok, false); assert.deepEqual(r.unreachable.sort(), ['ann', 'root']);
  });
  it('accepts when at least one administrator can, and lists who cannot', () => {
    const r = adminReachability({ root: [c('pk', 9)], ann: [c('pw', 3)] }, 8);
    assert.equal(r.ok, true); assert.deepEqual(r.reachable, ['root']); assert.deepEqual(r.unreachable, ['ann']);
  });
});

describe('options for a re-sign-in', () => {
  const cfg = { methods: [{ id: 'pw', type: 'password', enabled: true }, { id: 'tp', type: 'totp', enabled: true }, { id: 'pk', type: 'passkey', enabled: true }],
    chains: [{ id: 'basic', name: 'Password', steps: ['pw'] }, { id: 'mfa', name: 'Password then authenticator', steps: ['pw', 'tp'] }, { id: 'key', name: 'Passkey', steps: ['pk'] }] };
  const an = { basic: { effectiveLevel: 3, simulatedSteps: [] }, mfa: { effectiveLevel: 8, simulatedSteps: [] }, key: { effectiveLevel: 9, simulatedSteps: [] } };
  it('offers only chains the person has set up, that reach the level, never a weaker one', () => {
    const opts = chainOptions(cfg, an, { tp: { totp: true } });
    assert.deepEqual(eligibleChains(opts, 8).map((c) => c.id), ['mfa']);
    assert.deepEqual(eligibleChains(chainOptions(cfg, an, {}), 8), []);
    assert.deepEqual(eligibleChains(opts, 3).map((c) => c.id), ['basic', 'mfa']);
  });
  it('an enrolment is required for authenticator, PIN, passkey and external providers', () => {
    assert.equal(methodEnrolled('password', undefined), true); assert.equal(methodEnrolled('totp', undefined), false);
    assert.equal(methodEnrolled('passkey', { webauthn: [{}] }), true); assert.equal(methodEnrolled('sso-google', { external: { sub: 'x' } }), true); assert.equal(methodEnrolled('unknown', {}), false);
  });
});
