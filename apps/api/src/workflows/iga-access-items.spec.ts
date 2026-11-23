import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowsIgaService } from './iga.service.js';
function fixture() {
  let campaign: any; const items: any[] = []; let current = ['keep', 'remove'];
  const store: any = {
    igaPutCampaign: async (c: any, rows: any[]) => { campaign = c; items.push(...rows.map(r => ({ ...r, tenant: 'acme', campaign_id: c.id, state: 'pending' }))); },
    igaGetCampaign: async () => campaign,
    igaListItems: async (_t: string, _c: string, state?: string) => items.filter(i => !state || i.state === state),
    igaUpdateItem: async (id: string, patch: any) => Object.assign(items.find(i => i.id === id), patch),
    igaCloseCampaign: async (_id: string, _actor: string, _at: string, evidence: any) => { campaign = { ...campaign, status: 'closed', evidence }; return true; },
    getRun: async () => ({ id: 'run-1', status: 'completed', branch: 'workflow/one' }),
  };
  const reads: any = { readUser: async () => ({ id: 'emp', roles: ['not-a-direct-role'], displayName: 'Employee' }), listAssignments: async () => ({ count: current.length, assignments: current.map(role => ({ identity: 'emp', role })) }) };
  return { iga: new WorkflowsIgaService(store, undefined, reads), items, current: (roles: string[]) => { current = roles; } };
}
describe('IGA per-access review keeps independent decisions and direct provenance', () => {
  it('one item per direct assignment, deny one access, preserve the approved sibling, close with per-access evidence', async () => {
    const f = fixture();
    const c = await f.iga.createCampaign('acme', 'owner', { name: 'Q4', granularity: 'access', scope: { users: ['emp'] } });
    assert.equal(f.items.length, 2);
    const keep = f.items.find(i => i.payload.roles[0] === 'keep'), remove = f.items.find(i => i.payload.roles[0] === 'remove');
    assert.deepEqual(remove.payload.access.provenance, { type: 'direct', source: 'lyam.assignments', ref: 'main', identity: 'emp', role: 'remove' });
    assert.ok(!f.items.some(i => i.payload.roles.includes('not-a-direct-role')));
    keep.state = 'approved'; remove.state = 'denied';
    const prepared = await f.iga.prepareRemediation('acme', 'owner', c.id, {});
    assert.deepEqual(prepared.remediation[0].actions, [{ type: 'revoke-role', identity: 'emp', role: 'remove' }]);
    await f.iga.assertPreparedAction('acme', c.id, remove.id, 'emp', 'remove');
    await assert.rejects(f.iga.assertPreparedAction('acme', c.id, remove.id, 'emp', 'keep'), /not a prepared/);
    f.current(['keep']);
    await assert.rejects(f.iga.markRemediated('acme', 'workflow:run-1', c.id, 'emp', { runId: 'run-1' }), /ambiguous/);
    assert.equal((await f.iga.markRemediated('acme', 'workflow:run-1', c.id, remove.id, { runId: 'run-1' })).state, 'remediated');
    const closed = await f.iga.close('acme', 'owner', c.id);
    const evidence = closed.evidence.accessReviews as any[];
    assert.equal(evidence.length, 2);
    assert.equal(evidence.find(i => i.item === keep.id).state, 'approved');
    assert.equal(evidence.find(i => i.item === remove.id).state, 'remediated');
  });
  it('a changed role set refuses old preparation and changed-after-prepare action', async () => {
    const f = fixture();
    const c = await f.iga.createCampaign('acme', 'owner', { name: 'Q4', granularity: 'access', scope: { users: ['emp'] } });
    const item = f.items.find(i => i.payload.roles[0] === 'remove'); item.state = 'denied';
    f.current(['keep', 'remove', 'new']);
    assert.match((await f.iga.prepareRemediation('acme', 'owner', c.id, {})).remediation[0].conflict!, /changed/);
    f.current(['keep', 'remove']); await f.iga.prepareRemediation('acme', 'owner', c.id, {});
    f.current(['keep', 'remove', 'new']);
    await assert.rejects(f.iga.assertPreparedAction('acme', c.id, item.id, 'emp', 'remove'), /changed/);
  });
  it('legacy default keeps one person-level item, while role scope in access mode selects only that assignment', async () => {
    const legacy = fixture(); await legacy.iga.createCampaign('acme', 'owner', { name: 'Q4', scope: { users: ['emp'] } });
    assert.equal(legacy.items.length, 1);
    const access = fixture(); await access.iga.createCampaign('acme', 'owner', { name: 'Q4', granularity: 'access', scope: { users: ['emp'], role: 'keep' } });
    assert.equal(access.items.length, 1); assert.deepEqual(access.items[0].payload.roles, ['keep']);
  });
});
