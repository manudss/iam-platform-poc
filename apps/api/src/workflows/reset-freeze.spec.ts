import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isFrozenApprovedReset } from './reset-freeze.js';

describe('server-owned reset freeze detection', () => {
  const graph = (type: string, config: object = {}) => ({ nodes: [{ id: 'unreachable', type, config }], edges: [] });
  for (const type of ['lyam-propose-password-reset', 'lyam-apply-password-reset']) it(`freezes ${type} even when disconnected or given client enable flags`, () => {
    assert.equal(isFrozenApprovedReset(graph(type, { enabled: true, resetReady: true, dryRun: true })), true);
  });
  for (const type of ['lyam-publish-workspace', 'lyam-send-secret-mail']) it(`freezes guarded ${type} without an apply node`, () => {
    assert.equal(isFrozenApprovedReset(graph(type, { resetApprovalTaskId: '{{steps.old.taskId}}' })), true);
    assert.equal(isFrozenApprovedReset(graph(type)), false);
  });
  it('does not introduce approval/freeze into generic temporary-password or badge blocks', () => {
    for (const type of ['lyam-set-temporary-password', 'lyam-generate-password', 'lyam-block-account', 'lyam-publish-workspace', 'jira-transition-issue']) assert.equal(isFrozenApprovedReset(graph(type)), false);
  });
});
