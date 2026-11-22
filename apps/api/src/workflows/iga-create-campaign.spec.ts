import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowsIgaService } from './iga.service.js';

// Plan IGA step 1 ("freeze the scope, the whole population"): listUsers caps at 200 rows and reports the
// real total in count. A population beyond the cap must REFUSE the campaign (a frozen campaign never starts
// from a truncated population), and the stored scope records the population it froze.
// REAL: WorkflowsIgaService.createCampaign logic. DOUBLES: the store (in memory) and the reads.
function setup(population: { count: number; listed: number }) {
  const stored: { campaign?: Record<string, unknown>; items: unknown[] } = { items: [] };
  const store: any = {
    igaPutCampaign: async (c: Record<string, unknown>, items: unknown[]) => { stored.campaign = c; stored.items = items; },
    igaGetCampaign: async () => stored.campaign,
  };
  const reads: any = {
    listUsers: async (_t: string, _r: string, _f: { department?: string; limit?: number }) => ({
      count: population.count,
      users: Array.from({ length: population.listed }, (_, i) => ({ id: `u${i}`, displayName: `User ${i}`, department: 'it', manager: null, email: null, loginEnabled: true })),
    }),
    listAssignments: async () => ({ assignments: [{ role: 'r1' }] }),
    readUser: async (_t: string, _r: string, id: string) => ({ id, displayName: id, roles: ['r1'] }),
  };
  const iga = new WorkflowsIgaService(store, undefined as never, reads, undefined);
  return { iga, stored };
}

describe('iga campaign creation: the frozen scope is the complete population', () => {
  it('a population beyond the listing cap refuses the campaign instead of silently truncating it', async () => {
    const { iga, stored } = setup({ count: 350, listed: 200 });
    await assert.rejects(
      iga.createCampaign('acme', 'igaowner', { name: 'Q4', kind: 'user-access', ref: 'main', scope: { department: 'it' } }),
      /350 people.*never starts from a truncated population/);
    assert.equal(stored.campaign, undefined, 'nothing was stored');
  });
  it('a complete population creates the campaign and the frozen scope records the population', async () => {
    const { iga, stored } = setup({ count: 3, listed: 3 });
    const c = await iga.createCampaign('acme', 'igaowner', { name: 'Q4', kind: 'user-access', ref: 'main', scope: { department: 'it' } });
    assert.equal(c.status, 'open');
    assert.equal((stored.campaign!.scope as { population: number }).population, 3, 'the evidence carries the frozen population');
    assert.equal(stored.items.length, 3, 'every person in scope got an item');
  });
  it('an explicit user list freezes exactly that list and records its size', async () => {
    const { iga, stored } = setup({ count: 999, listed: 0 }); // the listing is never used for an explicit scope
    const c = await iga.createCampaign('acme', 'igaowner', { name: 'Q4', kind: 'user-access', ref: 'main', scope: { users: ['u1', 'u2'] } });
    assert.equal(c.status, 'open');
    assert.equal((stored.campaign!.scope as { population: number }).population, 2);
    assert.equal(stored.items.length, 2);
  });
});
