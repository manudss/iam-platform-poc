import test from 'node:test';
import assert from 'node:assert/strict';
import { apiTimeoutMs, API_TIMEOUT_MS, CHAT_IDLE_TIMEOUT_MS } from './timeout-policy.mjs';

const path = '/api/tenants/demo/ai/conversations/cv-0123456789ab/chat';
test('only the exact POST conversation chat route gets the streaming idle budget', () => {
  assert.equal(API_TIMEOUT_MS, 15_000);
  assert.equal(CHAT_IDLE_TIMEOUT_MS, 300_000);
  assert.equal(apiTimeoutMs('POST', path), CHAT_IDLE_TIMEOUT_MS);
  for (const method of ['GET', 'DELETE', 'PATCH', 'HEAD']) assert.equal(apiTimeoutMs(method, path), API_TIMEOUT_MS);
  for (const p of ['/api/health', '/api/tenants/demo/ai/models/test', path + '/extra', path + '/', path.replace('cv-0123456789ab', 'other'), path.replace('/ai/', '/workflows/'), '/api/tenants//ai/conversations/cv-0123456789ab/chat']) {
    assert.equal(apiTimeoutMs('POST', p), API_TIMEOUT_MS, p);
  }
});
