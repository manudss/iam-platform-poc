import { fromForm, toForm } from './account-protection';

const parsed = { lockout: { enabled: true, maxFailures: 5, windowMs: 900000, lockMs: 900000, hold: false, exempt: [] }, adminMinLevel: 5, adminMaxAgeSeconds: 1800, holdAfterVerification: true, appLevels: { finance: { minLevel: 8 } } };
describe('account protection settings form', () => {
  it('shows the stored values in minutes', () => {
    const f = toForm(parsed);
    expect(f).toMatchObject({ lockEnabled: true, maxFailures: 5, windowMinutes: 15, lockMinutes: 15, adminMinLevel: 5, adminMaxAgeMinutes: 30, holdAfterVerification: true });
    expect(f.appLevels).toEqual([{ id: 'finance', level: 8 }]);
  });
  it('saves seconds and keeps what the form does not show, application levels and their age limits included', () => {
    const f = toForm(parsed);
    const stored = { finance: { minLevel: 8, maxAgeSeconds: 300 }, wiki: { minLevel: 0, maxAgeSeconds: 60 } };
    const out = fromForm(f, { exempt: ['svc'], hold: true, appLevels: stored });
    expect(out.lockout).toEqual({ enabled: true, maxFailures: 5, windowSeconds: 900, lockSeconds: 900, hold: true, exempt: ['svc'] });
    expect(out.adminMaxAgeSeconds).toBe(1800);
    expect(out.appLevels).toEqual(stored);
  });
});
