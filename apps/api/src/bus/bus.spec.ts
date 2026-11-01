import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from './bus.controller.js';
describe('bus observer scrub', () => {
  it('masks credentials and e-mails again and keeps only known fields', () => {
    const r = scrub({ seq: 3, at_ms: 1, envelope_id: 'e', kind: 'k', mode: 'notify', payload: { password: 'p', authToken: 't', mail: 'alice@example.com', effectKey: 'x' }, elapsed_ms: 2, expected: [{ id: 'a', mandatory: true }], outcomes: [{ id: 'a', mandatory: true, status: 'silent', evil: 1 }], evil: 'x' });
    assert.deepEqual(r.payload, { password: '[masked]', authToken: '[masked]', mail: 'a***@e***.com', effectKey: 'x' });
    assert.equal((r as any).evil, undefined); assert.equal((r.outcomes[0] as any).evil, undefined);
    assert.deepEqual(r.expected[0], { id: 'a', mandatory: true });
  });
});
