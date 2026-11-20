import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECURITY, parseSecurity, storedSecurity, validateSecurity } from './security-config.js';

describe('security configuration', () => {
  it('starts with the owner lockout values (5 in 15 minutes for 15 minutes); the admin level starts off until raised', () => {
    const c = validateSecurity({});
    assert.deepEqual(c, DEFAULT_SECURITY);
    assert.equal(c.lockout.maxFailures, 5); assert.equal(c.lockout.windowMs, 900_000); assert.equal(c.lockout.lockMs, 900_000); assert.equal(c.adminMinLevel, 0);
  });
  it('everything is configurable and round-trips through the stored shape', () => {
    const c = validateSecurity({ lockout: { enabled: false, maxFailures: 3, windowSeconds: 60, lockSeconds: 120, hold: true, exempt: ['svc'] }, adminMinLevel: 8, adminMaxAgeSeconds: 600, holdAfterVerification: true, appLevels: { finance: { minLevel: 8, maxAgeSeconds: 900 }, wiki: { minLevel: 0 } } });
    assert.deepEqual(validateSecurity(storedSecurity(c)), c);
    assert.equal(c.lockout.enabled, false); assert.equal(c.adminMinLevel, 8);
  });
  it('refuses bad values and unknown fields', () => {
    for (const bad of [{ adminMinLevel: 11 }, { adminMinLevel: 'x' }, { lockout: { maxFailures: 0 } }, { lockout: { enabled: 'yes' } }, { appLevels: { 'Bad Id': { minLevel: 3 } } }, { appLevels: { x: { minLevel: 11 } } }, { nope: 1 }, { lockout: { nope: 1 } }, []]) assert.throws(() => validateSecurity(bad));
  });
  it('unusable stored data falls back to the defaults', () => {
    assert.deepEqual(parseSecurity({ adminMinLevel: 99 }), DEFAULT_SECURITY); assert.deepEqual(parseSecurity(undefined), DEFAULT_SECURITY);
  });
});
