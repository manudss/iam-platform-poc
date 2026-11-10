import test from 'node:test';
import assert from 'node:assert/strict';
import { framingHeaders } from './frame-policy.mjs';

test('only the Customisation previews can be framed, and only by the same origin', () => {
  for (const path of ['/login', '/admin-preview']) {
    assert.match(framingHeaders(path, '?preview=1')['content-security-policy'], /frame-ancestors 'self'/);
    assert.equal(framingHeaders(path, '?preview=1')['x-frame-options'], 'SAMEORIGIN');
  }
});
test('framing is refused everywhere else', () => {
  for (const [p, q] of [['/login', ''], ['/login', '?preview=0'], ['/admin-preview', ''], ['/admin-preview', '?preview=0'], ['/overview', '?preview=1'], ['/', ''], ['/signup', '?preview=1']]) {
    assert.equal(framingHeaders(p, q)['x-frame-options'], 'DENY', p + q);
    assert.match(framingHeaders(p, q)['content-security-policy'], /frame-ancestors 'none'/);
  }
});
