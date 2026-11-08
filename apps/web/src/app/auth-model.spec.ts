import type { AuthnConfig } from './auth-methods';
import { entries, inUse, notInUse, useEntry, removeFromList, moveInUse, reconcile, instanceCount, deleteMethod, addInstance } from './auth-model';

const base = (): AuthnConfig => ({
  methods: [
    { id: 'password', type: 'password', name: 'Password', enabled: true, level: 3, config: {} },
    { id: 'totp', type: 'totp', name: 'App', enabled: true, level: 7, config: {} },
  ],
  chains: [
    { id: 'pw', name: 'Password', enabled: true, steps: ['password'], level: 3 },
    { id: 'both', name: 'Password then app', enabled: true, steps: ['password', 'totp'], level: 7 },
  ],
  defaultChain: null,
});
const avail = (totp = true) => ({ methods: { password: { available: true }, totp: { available: totp } }, chains: {} });

describe('auth model', () => {
  it('shows a solo chain as a method and chains in use first', () => {
    const e = entries(base(), avail());
    expect(e.map((x) => x.key)).toEqual(['m:password', 'c:both', 'm:totp']);
    expect(inUse(base(), avail()).length).toBe(2);
    expect(notInUse(base(), avail()).map((x) => x.key)).toEqual(['m:totp']);
  });
  it('uses and removes from the list', () => {
    const c = base(); const t = entries(c, avail()).find((x) => x.key === 'm:totp')!;
    expect(useEntry(c, t, avail())).toBeTruthy();
    expect(inUse(c, avail()).map((x) => x.key)).toContain('m:totp');
    removeFromList(c, entries(c, avail()).find((x) => x.key === 'm:totp')!);
    expect(notInUse(c, avail()).map((x) => x.key)).toContain('m:totp');
  });
  it('reorders the sign-in list', () => {
    const c = base(); moveInUse(c, entries(c, avail())[1], 0);
    expect(inUse(c, avail()).map((x) => x.key)).toEqual(['c:both', 'm:password']);
  });
  it('drops entries whose plugin is gone, with a reason', () => {
    const c = base(); const d = reconcile(c, avail(false));
    expect(d.length).toBeGreaterThan(0);
    expect(inUse(c, avail(false)).map((x) => x.key)).toEqual(['m:password']);
    const t = entries(c, avail(false)).find((x) => x.key === 'm:totp')!;
    expect(useEntry(c, t, avail(false))).toBeNull();
  });
  it('counts instances and refuses a second single instance', () => {
    const c = base(); expect(instanceCount(c, 'totp')).toBe(1);
    const t = { id: 'password', name: 'Password', suggestedLevel: 3, instances: 'single' as const, settings: [] };
    expect(addInstance(c, t, 'Another', 3, {})).toBeNull();
    const m = { ...t, id: 'totp', instances: 'multiple' as const };
    expect(addInstance(c, m, 'App 2', 7, {})).not.toBeNull();
    expect(instanceCount(c, 'totp')).toBe(2);
  });
  it('deleting a method is refused while a chain uses it as a step', () => {
    expect(deleteMethod(base(), 'totp')).toBe(false);
  });
  it('regression: adding a first step to a new chain keeps the same entry (the drawer must not vanish)', () => {
    const c = base(); c.chains.push({ id: 'mine', name: 'Mine', enabled: false, steps: [], level: 1 });
    const before = entries(c, avail()).find((x) => x.chainId === 'mine')!;
    c.chains.find((x) => x.id === 'mine')!.steps.push('totp');
    const after = entries(c, avail()).find((x) => x.chainId === 'mine')!;
    expect(after.key).toBe(before.key); expect(after.kind).toBe('chain');
    expect(entries(c, avail()).some((x) => x.key === 'm:totp')).toBe(true); // the method itself stays listed
  });
});
