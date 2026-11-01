import { describe, it, expect } from 'vitest';
import { bucketize, silent, JEntry } from './journal';

const e = (at: string, outcome = 'ok', candidates = ['a', 'b'], answered = ['a']): JEntry => ({ id: at, at, kind: 'plugin-hook', name: 'h', mode: 'blocking', candidates, answered, outcome, payload: {} });
describe('journal helpers', () => {
  it('buckets calls into the period and flags refused ones', () => {
    const from = Date.parse('2026-11-01T00:00:00Z'), to = from + 24 * 3600e3;
    const b = bucketize([e('2026-11-01T00:30:00Z'), e('2026-11-01T00:40:00Z', 'refused'), e('2026-10-31T23:00:00Z')], from, to, 24);
    expect(b.length).toBe(24); expect(b[0].count).toBe(2); expect(b[0].bad).toBe(1); expect(b.reduce((n, x) => n + x.count, 0)).toBe(2);
  });
  it('lists plugins that could answer but did not', () => { expect(silent(e('2026-11-01T00:00:00Z'))).toEqual(['b']); });
});
