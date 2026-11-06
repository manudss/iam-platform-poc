import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BusHost } from './bus-host.js';

describe('bus verdict classification', () => {
  const classify = async (outcomes: unknown[]) => {
    const host = Object.create(BusHost.prototype) as BusHost;
    Object.assign(host, { post: async () => ({ verdict: 'deny', outcomes }) });
    return host.bridge().call('tenant', 'auth.authenticate', {}, 1000, 'main');
  };
  const denial = { id: 'password', status: 'replied', mandatory: true, verdict: 'deny', data: { outcome: 'deny', reason: 'bad-credentials' } };
  it('a valid business denial is returned as denial data', async () => {
    const r = await classify([denial, { id: 'other', mandatory: true, status: 'not-concerned' }]);
    assert.equal(r.businessDenial, true); assert.equal(r.answeredBy, 'password');
  });
  it('business denial never hides a silent or faulty mandatory subscriber', async () => {
    for (const status of ['silent', 'invalid']) assert.equal((await classify([denial, { id: 'ghost', mandatory: true, status }])).businessDenial, false);
    assert.equal((await classify([denial, { id: 'faulted', mandatory: true, status: 'replied', verdict: 'deny', data: { error: 'plugin faulted' } }])).businessDenial, false);
  });
});
