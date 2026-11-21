import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeReason } from './log-safe.js';

describe('safeReason', () => {
  it('keeps the class and a bounded code, never the message', () => {
    assert.equal(safeReason(Object.assign(new TypeError('token FICTIONAL-SECRET leaked'), { code: 'ECONNRESET' })), 'TypeError ECONNRESET');
    assert.equal(safeReason(new Error('FICTIONAL-SECRET')), 'Error');
    assert.equal(safeReason(Object.assign(new Error('x'), { code: 'bad code with FICTIONAL-SECRET' })), 'Error');
    assert.equal(safeReason('FICTIONAL-SECRET'), 'Error');
    assert.equal(safeReason(null), 'Error');
  });
});
