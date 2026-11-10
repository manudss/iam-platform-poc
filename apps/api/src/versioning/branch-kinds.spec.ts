import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoBranchName, branchKind, sourceAllowed } from './branch-kinds.js';
import { newBranchName } from './guards.js';

describe('branch kinds (folder naming convention)', () => {
  it('classifies folders and keeps legacy names working', () => {
    assert.equal(branchKind('personal/demo-alice'), 'personal');
    assert.equal(branchKind('profile/pend-dan'), 'profile');
    assert.equal(branchKind('ai/mcp-0123456789ab'), 'ai');
    assert.equal(branchKind('workflow/0a1b2c3d'), 'workflow');
    assert.equal(branchKind('feature/x'), 'feature');
    assert.equal(branchKind('profile-pend-dan'), 'profile');
    assert.equal(branchKind('mcp-0123456789ab'), 'ai');
    assert.equal(branchKind('wf-0a1b2c3d'), 'workflow');
    assert.equal(branchKind('demo-alice'), 'other');
    assert.equal(branchKind('team/x'), 'custom');
    assert.equal(sourceAllowed(['custom:team'], 'team/x'), true);
    assert.equal(sourceAllowed(['custom:team'], 'squad/x'), false);
    assert.equal(sourceAllowed(['custom'], 'squad/x'), true);
    assert.equal(sourceAllowed(['feature'], 'team/x'), false);
    assert.equal(sourceAllowed([], 'anything'), true);
  });
  it('builds valid names and refuses a second folder level', () => {
    assert.equal(autoBranchName('personal', 'a b'), 'personal/a-b');
    assert.ok(autoBranchName('ai', 'x'.repeat(100)).length <= 63);
    assert.equal(newBranchName('feature/x'), 'feature/x');
    assert.throws(() => newBranchName('a/b/c'));
  });
});
