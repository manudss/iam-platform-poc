import { fromForm, toForm } from './account-protection';

const parsed = { lockout: { enabled: true, maxFailures: 5, windowMs: 900000, lockMs: 900000, hold: false, exempt: [] }, adminMinLevel: 5, adminMaxAgeSeconds: 1800, holdAfterVerification: true, appLevels: { finance: { minLevel: 8 } } };
describe('account protection settings form', () => {
  it('shows the stored values in minutes', () => {
    const f = toForm(parsed);
    expect(f).toMatchObject({ lockEnabled: true, maxFailures: 5, windowMinutes: 15, lockMinutes: 15, adminMinLevel: 5, adminMaxAgeMinutes: 30, holdAfterVerification: true });
    expect(f.appLevels).toEqual([{ id: 'finance', level: 8 }]);
  });
  it('saves seconds, keeps what the form does not show, and drops an application at level 0 or without an id', () => {
    const f = toForm(parsed); f.appLevels.push({ id: 'wiki', level: 0 }, { id: '  ', level: 5 });
    const out = fromForm(f, { exempt: ['svc'], hold: true });
    expect(out.lockout).toEqual({ enabled: true, maxFailures: 5, windowSeconds: 900, lockSeconds: 900, hold: true, exempt: ['svc'] });
    expect(out.adminMaxAgeSeconds).toBe(1800);
    expect(out.appLevels).toEqual({ finance: { minLevel: 8 } });
  });
});
