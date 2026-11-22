import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowsIgaService } from './iga.service.js';

// markRemediated against a fake store/reads: the verification gate on the campaign ref, and the
// vacuous case (a denied item whose snapshot held NO role: nothing to revoke, must not strand the campaign).
function svc(opts: { roles: string[]; onRef: string[]; runBranch?: string | null; runStatus?: string }) {
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const store = {
    igaGetCampaign: async () => ({ id: 'iga-1', tenant: 'acme', kind: 'user-access', name: 'Q4', ref: 'main', status: 'open', scope: {}, created_by: 'a', created_at: 'now', closed_by: null, closed_at: null, evidence: null }),
    igaListItems: async () => [{ id: 'item-1', tenant: 'acme', campaign_id: 'iga-1', identity: 'emp', kind: 'user-access', action: 'review', payload: { roles: opts.roles, remediation: opts.roles.map((r) => ({ type: 'revoke-role', identity: 'emp', role: r })) }, state: 'remediation-prepared', decided_by: 'boss', decided_at: 'now', decision_reason: 'x', run_id: null }],
    getRun: async () => ({ id: 'run-1', status: opts.runStatus ?? 'completed', branch: opts.runBranch === undefined ? 'wf-run-1' : opts.runBranch }),
    igaUpdateItem: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); return true; },
  };
  const reads = { listAssignments: async (_ref: string, q: { identity: string }) => ({ assignments: opts.onRef.filter(() => q.identity === 'emp').map((role) => ({ identity: 'emp', role })) }) };
  const service = new WorkflowsIgaService(store as never, undefined, reads as never, undefined);
  return { service, updates };
}

describe('iga markRemediated (service gate)', () => {
  it('a denied item with NO role at snapshot is vacuously remediated: nothing to verify, never stranded', async () => {
    const { service, updates } = svc({ roles: [], onRef: [] });
    const out = await service.markRemediated('acme', 'workflow:run-1', 'iga-1', 'item-1', { runId: 'run-1', note: 'denied, nothing held' });
    assert.equal(out.state, 'remediated');
    assert.equal(updates[0].patch.state, 'remediated');
  });
  it('revoked and published roles pass; roles still on the ref refuse; an unmerged branch is reported', async () => {
    const okCase = svc({ roles: ['a'], onRef: [] });
    assert.equal((await okCase.service.markRemediated('acme', 'workflow:run-1', 'iga-1', 'emp', { runId: 'run-1' })).state, 'remediated');
    const stillThere = svc({ roles: ['a'], onRef: ['a'] });
    await assert.rejects(stillThere.service.markRemediated('acme', 'workflow:run-1', 'iga-1', 'emp', { runId: 'run-1' }), /still assigned/);
    const unmerged = svc({ roles: ['a'], onRef: ['a'], runBranch: 'wf-run-1' });
    await assert.rejects(unmerged.service.markRemediated('acme', 'workflow:run-1', 'iga-1', 'emp', { runId: 'run-1' }), /still assigned|not published/);
    const noBranch = svc({ roles: ['a'], onRef: [], runBranch: null });
    await assert.rejects(noBranch.service.markRemediated('acme', 'workflow:run-1', 'iga-1', 'emp', { runId: 'run-1' }), /no data branch/);
  });
});
