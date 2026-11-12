import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readPreferences, validatePreferences } from './launchpad.js';
describe('personal launchpad preferences', () => {
  it('drops stale/inaccessible IDs and duplicates while preserving order', () => {
    assert.deepEqual(readPreferences({ favourites: ['b','private','b'], order: ['b','a','gone'] }, ['a','b']), { favourites: ['b'], order: ['b','a'] });
    assert.deepEqual(readPreferences(null, ['a']), { favourites: [], order: [] });
  });
  it('accepts only explicit unique accessible IDs, not a target subject or tenant', () => {
    assert.deepEqual(validatePreferences({ favourites: ['b'], order: ['b','a'] }, ['a','b']), { favourites: ['b'], order: ['b','a'] });
    for (const value of [null, [], {}, { favourites: ['x'], order: [] }, { favourites: ['a','a'], order: [] }, { favourites: [], order: [], subject: 'another-user' }]) assert.throws(() => validatePreferences(value, ['a']));
  });
});
