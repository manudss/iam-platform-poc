import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoBranchName, branchKind } from './branch-kinds.js';
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
  });
  it('builds valid names and refuses a second folder level', () => {
    assert.equal(autoBranchName('personal', 'a b'), 'personal/a-b');
    assert.ok(autoBranchName('ai', 'x'.repeat(100)).length <= 63);
    assert.equal(newBranchName('feature/x'), 'feature/x');
    assert.throws(() => newBranchName('a/b/c'));
  });
});
