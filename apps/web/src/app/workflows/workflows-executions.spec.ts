import { stepDataLink } from './executions';

// "Open the row in Data" (phase 3): the deep link derived from a step's recorded write.
describe('stepDataLink', () => {
  it('links an assign-role write to the assignments row on the run branch', () => {
    expect(stepDataLink('wf-run-1', { identity: 'demo-bob', role: 'employee', dataRow: { table: 'assignments', pk: { identity_id: 'demo-bob', role_id: 'employee' } } }))
      .toEqual({ table: 'assignments', ref: 'wf-run-1', filter: 'demo-bob', removed: false });
  });
  it('marks a revoke as a removed row and keeps the identity filter', () => {
    expect(stepDataLink('wf-run-1', { dataRow: { table: 'assignments', pk: { identity_id: 'demo-bob', role_id: 'employee' }, removed: true } })?.removed).toBe(true);
  });
  it('prefers the identity-ish pk columns over the tenant for the row filter', () => {
    const l = stepDataLink('wf-run-1', { dataRow: { table: 'profile_field_values', pk: { tenant: 'acme', subject: 'demo-bob', field_key: 'badge' } } });
    expect(l?.filter).toBe('demo-bob');
    expect(stepDataLink('wf-run-1', { dataRow: { table: 'identities', pk: { id: 'demo-bob' } } })?.filter).toBe('demo-bob');
  });
  it('no link without a write, a branch or a pk', () => {
    expect(stepDataLink('wf-run-1', { identity: 'demo-bob' })).toBeNull();
    expect(stepDataLink(null, { dataRow: { table: 'assignments', pk: { identity_id: 'x' } } })).toBeNull();
    expect(stepDataLink('wf-run-1', { dataRow: { table: 'assignments' } })).toBeNull();
    expect(stepDataLink('wf-run-1', null)).toBeNull();
  });
});
