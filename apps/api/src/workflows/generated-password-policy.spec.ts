import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { randomPassword } from './run-secrets.js';
// The generated temporary password against the REAL password-policy plugin handler (pure, no store): strictest shipped rules, many samples.
const policy = (loadPluginModule('auth-password-policy', 'handlers.mjs') as any).default;
const STRICT = { minLength: 20, maxLength: 128, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: true, minClasses: 4, blockCommon: true, forbidUserInfo: true, forbiddenWords: ['password', 'azerty', 'lyam'] };
const check = (candidate: string, settings: any = STRICT, userInfo: any = { login: 'bao.nguyen', displayName: 'Bao Nguyen', email: 'bao.nguyen@example.test' }) =>
  policy['auth.password.validate']({ candidate, userInfo, history: [] }, { settings, base: {} });

describe('generated temporary password vs the real policy', () => {
  it('3000 samples: length, the four classes, no common word; account-token collisions are rare and refused (fail closed), never accepted', () => {
    let tokenRefusals = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const p = randomPassword();
      seen.add(p);
      assert.equal(p.length, 20);
      const r = check(p);
      if (!r.ok) { assert.deepEqual(r.errors, ['it must not contain the login, the name or the e-mail address']); tokenRefusals++; }
    }
    assert.equal(seen.size, 3000, 'no repeats');
    assert.ok(tokenRefusals < 30, `token collisions should be about 0, got ${tokenRefusals}`);
  });
  it('the policy decision is not skipped: a candidate that breaks it is refused with data, so the set-temporary block would stop before any write', () => {
    assert.equal(check('Short1!').ok, false);
    assert.equal(check('bao.nguyen-Aa1!-xxxxxxxx').ok, false);
    assert.equal(check('xx-Password-Aa1-xxxxxxxx-1').ok, false);
  });
  it('a stricter-than-generator setting (minLength above 20) refuses every sample: fail closed, nothing is stored', () => {
    for (let i = 0; i < 20; i++) assert.equal(check(randomPassword(), { ...STRICT, minLength: 40 }).ok, false);
  });
});
