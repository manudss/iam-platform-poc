import { it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForCondition } from './wait-for-condition.js';

it('an earlier sink acknowledgement does not satisfy the durable completion barrier', async () => {
  let polls = 0;
  const acknowledged = true;
  await waitForCondition(async () => {
    polls++;
    const durableDone = polls >= 3;
    return acknowledged && durableDone;
  }, { timeoutMs: 500, intervalMs: 1, label: 'durable ledger' });
  assert.equal(polls, 3);
});
it('missing durable completion fails even if every external call was acknowledged', async () => {
  await assert.rejects(waitForCondition(async () => false,
    { timeoutMs: 5, intervalMs: 1, label: 'all 14 effects done' }), /timed out waiting for all 14 effects done/);
});
it('a read failure is not silently treated as completion or swallowed until timeout', async () => {
  const error = new Error('ledger unavailable');
  await assert.rejects(waitForCondition(async () => { throw error; },
    { timeoutMs: 500, intervalMs: 1, label: 'ledger' }), (e) => e === error);
});
