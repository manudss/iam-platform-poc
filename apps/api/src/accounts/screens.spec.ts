import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { screensFor, SCREENS } from '../auth/screens.js';
import { APP_EVENT_KINDS } from '../events/application-bus.service.js';

describe('block management is a right of its own', () => {
  it('its routes belong to the screen account-blocks, security settings to Authentication', () => {
    assert.ok((SCREENS as readonly string[]).includes('account-blocks'));
    for (const [m, p] of [['GET', 'account-blocks'], ['POST', 'accounts/emp/blocks'], ['DELETE', 'accounts/emp/blocks/abc']]) assert.deepEqual(screensFor(m, p), ['account-blocks']);
    assert.deepEqual(screensFor('PUT', 'security'), ['authentication']);
  });
  it('the demo policy gives the right to managers and administrators, by a rule that can be edited apart', () => {
    const cedar = readFileSync(new URL('../../../../policies/demo.cedar', import.meta.url), 'utf8');
    const rule = cedar.split('@id(').find((r) => r.startsWith('"screen-account-blocks"'))!;
    assert.ok(rule.includes('Screen::"account-blocks"') && rule.includes('"manager"') && rule.includes('"main-merger"'));
  });
  it('workflows can start on a block or an unblock', () => { for (const k of ['user.blocked', 'user.unblocked']) assert.ok((APP_EVENT_KINDS as readonly string[]).includes(k)); });
});
