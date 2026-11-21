import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adminReachability, chainOptions, methodEnrolled, checkAssurance, eligibleChains, sameAccount, type ChainOption } from './step-up.js';

const c = (id: string, level: number, o: Partial<ChainOption> = {}): ChainOption => ({ id, name: id, enabled: true, effectiveLevel: level, simulated: false, enrolled: true, declaredLevel: level, mfa: false, recommended: false, steps: [], ...o });

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
  const cfg = { methods: [{ id: 'pw', type: 'password', enabled: true, name: 'Password' }, { id: 'tp', type: 'totp', enabled: true, name: 'Authenticator app' }, { id: 'pk', type: 'passkey', enabled: true, name: 'Passkey' }],
    chains: [{ id: 'basic', name: 'Password', level: 3, steps: ['pw'] }, { id: 'mfa', name: 'Password then authenticator', level: 8, steps: ['pw', 'tp'] }, { id: 'key', name: 'Passkey', level: 9, steps: ['pk'] }] };
  const an = { basic: { effectiveLevel: 3, simulatedSteps: [] as string[], mfa: false }, mfa: { effectiveLevel: 8, simulatedSteps: [] as string[], mfa: true }, key: { effectiveLevel: 9, simulatedSteps: [] as string[], mfa: false } };
  it('offers only chains the person has set up, that reach the level, never a weaker one', () => {
    const opts = chainOptions(cfg, an, { tp: { totp: true } });
    assert.deepEqual(eligibleChains(opts, 8).map((c) => c.id), ['mfa']);
    assert.deepEqual(eligibleChains(chainOptions(cfg, an, {}), 8), []);
    assert.deepEqual(eligibleChains(opts, 3).map((c) => c.id), ['basic', 'mfa']);
  });
  it('carries the sign-in page display shape: declared level, steps detail, mfa and the default flag', () => {
    const full = chainOptions({ ...cfg, defaultChain: 'mfa' }, an, { tp: { totp: true } });
    const mfa = full.find((x) => x.id === 'mfa')!;
    assert.equal(mfa.declaredLevel, 8); assert.equal(mfa.mfa, true); assert.equal(mfa.recommended, true);
    assert.deepEqual(mfa.steps, [{ name: 'Password', type: 'password', simulated: false }, { name: 'Authenticator app', type: 'totp', simulated: false }]);
    assert.equal(full.find((x) => x.id === 'basic')!.recommended, false);
  });
  it('an enrolment is required for authenticator, PIN, passkey and external providers', () => {
    assert.equal(methodEnrolled('password', undefined), true); assert.equal(methodEnrolled('totp', undefined), false);
    assert.equal(methodEnrolled('passkey', { webauthn: [{}] }), true); assert.equal(methodEnrolled('sso-google', { external: { sub: 'x' } }), true); assert.equal(methodEnrolled('unknown', {}), false);
  });
});
