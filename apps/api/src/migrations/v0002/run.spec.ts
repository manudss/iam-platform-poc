import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planAccountBlocksRule } from './run.js';
import { ACCOUNT_BLOCKS_RULE } from './rule.js';

const row = (id: string, cedar = 'permit(principal, action, resource);', set_name = 'default') => ({ set_name, id, cedar });
describe('migration 0002: account-blocks screen rule', () => {
  it('adds the rule when the default set lacks it', () => assert.equal(planAccountBlocksRule([row('screen-my-profile')]), 'added'));
  it('is a no-op once the rule exists (second boot)', () => assert.equal(planAccountBlocksRule([row('screen-account-blocks')]), 'already-present'));
  it('keeps a tenant rule under another id for the same screen', () => assert.equal(planAccountBlocksRule([row('my-own', 'permit(principal, action, resource == Screen::"account-blocks");')]), 'customised'));
  it('does not invent a policy set', () => assert.equal(planAccountBlocksRule([row('x', undefined, 'other')]), 'no-policy-set'));
  it('never touches other custom rules: the decision depends on the id and the screen only', () => assert.equal(planAccountBlocksRule([row('screen-people-admin', 'changed by the tenant')]), 'added'));
  it('frozen text equals the boot policy file and stays an access-only rule', () => {
    const file = readFileSync(resolve('../..', 'policies/demo.cedar'), 'utf8');
    assert.ok(file.includes(ACCOUNT_BLOCKS_RULE));
    assert.match(ACCOUNT_BLOCKS_RULE, /^@id\("screen-account-blocks"\)/);
    assert.ok(!/iam-admin/.test(ACCOUNT_BLOCKS_RULE.replace(/@description\([^)]*\)/, '')));
  });
});
