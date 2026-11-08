import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { demoProfileEmail } from './demo-email.js';

// The demo profile e-mail comes from IAM_DEMO_PROFILE_EMAIL (server environment only, never from the repo).
// A missing or malformed value must be ignored so the seed keeps the fictional example.invalid address.
describe('demoProfileEmail', () => {
  it('returns undefined when the variable is unset or empty', () => {
    assert.equal(demoProfileEmail(undefined), undefined);
    assert.equal(demoProfileEmail(''), undefined);
  });
  it('accepts a plain e-mail address', () => {
    assert.equal(demoProfileEmail('demo@example.com'), 'demo@example.com');
  });
  it('rejects malformed values instead of seeding them', () => {
    for (const bad of ['not-an-email', 'a@b@ c', 'x'.repeat(255) + '@example.com', 'a b@example.com', 'a@', '@b.com']) assert.equal(demoProfileEmail(bad), undefined, bad);
  });
});
